// /api/mollie-webhook.js
// Disease Atlas — Mollie Webhook Handler
//
// Receives payment status notifications from Mollie.
// CRITICAL: Always verifies payment by calling back to Mollie API — never trusts POST body.
//
// Handles both:
//   - First payments (from create-checkout): updates deal, creates subscription,
//     creates HubSpot invoice, sets platform access, triggers confirmation email
//   - Recurring payments (from active subscriptions): extends expiration,
//     creates renewal invoice, updates contact tracking
//
// Design doc: wiki/architecture/direct-checkout-implementation.md
// WF1 spec: "WF1 - Payment Result Workflow Spec.md"

const { createMollieClient } = require('@mollie/api-client');
const hubspot = require('@hubspot/api-client');

const mollieClient = createMollieClient({ apiKey: process.env.MOLLIE_API_KEY });
const hubspotClient = new hubspot.Client({ accessToken: process.env.HUBSPOT_PRIVATE_APP_TOKEN });

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

// HubSpot SaaS Billing pipeline stage IDs
const STAGES = {
  AWAITING_PAYMENT: '3912561851',
  CLOSED_WON_ONETIME: '3912561853',
  CLOSED_WON_SUBSCRIPTION: '3912561854',
  LOST_PAYMENT_FAILED: '3912561855',
};

// Mollie subscription interval format
const SUBSCRIPTION_INTERVALS = {
  monthly: '1 month',
  annual: '12 months',
};

// Plan → Cerebrum subscription type mapping
// academic-pro = individual researcher, academic-team + professional = collaborative (shared folders)
const PLAN_TO_SUBSCRIPTION_TYPE = {
  'academic-pro': 'Academic',
  'academic-team': 'Corporate',
  'professional': 'Corporate',
};

// HubSpot product IDs for invoice line items
// Each product has both EUR and USD pricing — HubSpot uses the invoice currency to pick the right price
const PRODUCT_IDS = {
  'academic-pro':  { annual: '303396659393', monthly: '303447504112' },
  'academic-team': { annual: '303387271358', monthly: '303447504114' },
  'professional':  { annual: '303649001666', monthly: '303649001669' },
};

// Mollie payment method → HubSpot enum mapping
const PAYMENT_METHOD_MAP = {
  ideal: 'ideal',
  creditcard: 'card',
  banktransfer: 'sepa_direct_debit',
  directdebit: 'sepa_direct_debit',
  paypal: 'paypal',
  applepay: 'apple_pay',
  googlepay: 'google_pay',
  paybybank: 'pay_by_bank',
};

// Email Octopus — direct API integration (replaces Zapier middleman)
const EMAILOCTOPUS_API_KEY = process.env.EMAILOCTOPUS_API_KEY || '';
const OCTOPUS_LIST_PAID = process.env.OCTOPUS_LIST_PAID || '';
const OCTOPUS_LIST_FAILED = process.env.OCTOPUS_LIST_FAILED || '';
const OCTOPUS_AUTOMATION_PAID = process.env.OCTOPUS_AUTOMATION_PAID || '';
const OCTOPUS_AUTOMATION_FAILED = process.env.OCTOPUS_AUTOMATION_FAILED || '';

// ─────────────────────────────────────────────────────────────────────────────
// Main Handler
// ─────────────────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  // Mollie expects 200 OK — if we return anything else, it retries
  // So we always return 200, even on errors (log them for debugging)
  if (req.method !== 'POST') return res.status(405).end();

  try {
    // Mollie sends { id: 'tr_xxxxx' } in the POST body
    const paymentId = req.body.id;
    if (!paymentId) {
      console.error('Webhook called without payment ID');
      return res.status(200).end();
    }

    // ── CRITICAL: Verify payment by calling back to Mollie API ──
    // Never trust the webhook POST body for payment status
    const payment = await mollieClient.payments.get(paymentId);
    const metadata = payment.metadata || {};
    const { dealId, contactId, plan, interval, vatTreatment, currency } = metadata;

    if (!dealId) {
      console.error(`Payment ${paymentId} has no dealId in metadata — skipping`);
      return res.status(200).end();
    }

    // ── Idempotency: check if deal is already in a terminal stage ──
    try {
      const deal = await hubspotClient.crm.deals.basicApi.getById(dealId, ['dealstage', 'payment_status']);
      const currentStage = deal.properties.dealstage;
      const terminalStages = [STAGES.CLOSED_WON_ONETIME, STAGES.CLOSED_WON_SUBSCRIPTION, STAGES.LOST_PAYMENT_FAILED];

      if (terminalStages.includes(currentStage) && payment.sequenceType !== 'recurring') {
        console.log(`Deal ${dealId} already in terminal stage ${currentStage} — skipping webhook for ${paymentId}`);
        return res.status(200).end();
      }
    } catch (err) {
      console.error(`Failed to check deal ${dealId} stage:`, err.message);
      // Continue processing — better to risk a duplicate update than miss a payment
    }

    // ── Route based on payment status ──
    if (payment.status === 'paid') {
      await handlePaid(payment, metadata);
    } else if (['failed', 'canceled', 'expired'].includes(payment.status)) {
      await handleFailed(payment, metadata);
    }
    // 'open', 'pending' — no action needed, wait for final status

    return res.status(200).end();

  } catch (err) {
    console.error('Webhook error:', err);
    // Always return 200 to prevent Mollie retry storms
    return res.status(200).end();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

// Calculate platform expiration date based on billing interval
// Cerebrum checks this date to grant/deny access
// Monthly gets a few days buffer beyond next payment due date
// If recurring payment fails, admin can manually extend ~1 month in HubSpot
function calculateExpirationDate(interval) {
  const d = new Date();
  if (interval === 'annual') {
    d.setFullYear(d.getFullYear() + 1);
  } else {
    d.setDate(d.getDate() + 35); // ~1 month + buffer
  }
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

// Human-readable subscription period for invoice custom field
function getSubscriptionPeriod(interval) {
  const start = new Date();
  const end = new Date();
  if (interval === 'annual') {
    end.setFullYear(end.getFullYear() + 1);
  } else {
    end.setMonth(end.getMonth() + 1);
  }
  const fmt = (d) => d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
  return `${fmt(start)} – ${fmt(end)}`;
}

// EU VAT compliance note for invoice
function getVatNote(vatTreatment) {
  if (vatTreatment === 'reverse_charge') return 'Reverse Charge — Article 196 EU VAT Directive';
  if (vatTreatment === 'export') return 'Export — 0% VAT';
  return ''; // standard VAT — rate shown in line items
}

// ─────────────────────────────────────────────────────────────────────────────
// HubSpot Invoice Creation
// ─────────────────────────────────────────────────────────────────────────────

// Creates a HubSpot invoice, associates with contact + line item, sets to open.
// HubSpot auto-assigns the invoice number (DA-2026-NNNN) based on portal settings.
// Returns { invoiceId, invoiceNumber, invoiceLink } or null on failure.
async function createHubSpotInvoice(payment, metadata, contactId) {
  const { plan, interval, vatTreatment, currency } = metadata;
  const today = new Date().toISOString().split('T')[0];
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 30);

  try {
    // Step 1: Create draft invoice
    const invoiceRes = await hubspotClient.apiRequest({
      method: 'POST',
      path: '/crm/v3/objects/invoices',
      body: {
        properties: {
          hs_currency: currency || 'EUR',
          hs_invoice_date: today,
          hs_due_date: dueDate.toISOString().split('T')[0],
          hs_invoice_status: 'draft',
          customer_vat_id: metadata.vatId || '',
          vat_note: getVatNote(vatTreatment),
          subscription_period: getSubscriptionPeriod(interval),
        },
      },
    });

    const invoiceData = await invoiceRes.json();
    const invoiceId = invoiceData.id;
    if (!invoiceId) {
      console.error('HubSpot invoice creation returned no ID:', invoiceData);
      return null;
    }

    // Step 2: Associate invoice with contact
    await hubspotClient.apiRequest({
      method: 'PUT',
      path: `/crm/v4/objects/invoices/${invoiceId}/associations/default/contacts/${contactId}`,
    });

    // Step 3: Create line item from product catalog and associate with invoice
    const productId = PRODUCT_IDS[plan]?.[interval];
    if (productId) {
      const lineItemRes = await hubspotClient.apiRequest({
        method: 'POST',
        path: '/crm/v3/objects/line_items',
        body: {
          properties: {
            hs_product_id: productId,
            quantity: '1',
          },
        },
      });
      const lineItemData = await lineItemRes.json();

      if (lineItemData.id) {
        await hubspotClient.apiRequest({
          method: 'PUT',
          path: `/crm/v4/objects/invoices/${invoiceId}/associations/default/line_items/${lineItemData.id}`,
        });
      }
    } else {
      console.warn(`No product ID found for ${plan}/${interval}/${currency} — invoice has no line items`);
    }

    // Step 4: Move invoice to open (HubSpot generates the hosted URL)
    await hubspotClient.apiRequest({
      method: 'PATCH',
      path: `/crm/v3/objects/invoices/${invoiceId}`,
      body: {
        properties: { hs_invoice_status: 'open' },
      },
    });

    // Step 5: Read back to get auto-assigned invoice number and link
    const readRes = await hubspotClient.apiRequest({
      method: 'GET',
      path: `/crm/v3/objects/invoices/${invoiceId}?properties=hs_invoice_link,hs_number`,
    });
    const readData = await readRes.json();

    const invoiceNumber = readData.properties?.hs_number || '';
    const invoiceLink = readData.properties?.hs_invoice_link || '';

    console.log(`Invoice created: ${invoiceNumber} (ID ${invoiceId}), link: ${invoiceLink}`);
    return { invoiceId, invoiceNumber, invoiceLink };

  } catch (err) {
    console.error('Failed to create HubSpot invoice:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Email Octopus — Direct API Integration
// ─────────────────────────────────────────────────────────────────────────────

// Adds a contact to an Email Octopus list and triggers an automation.
// The automation must have "Started via API" trigger type in Email Octopus.
async function triggerEmailOctopus(listId, automationId, email, fields) {
  if (!EMAILOCTOPUS_API_KEY || !listId) {
    console.warn('Email Octopus not configured — skipping email trigger');
    return;
  }

  try {
    // Step 1: Add/update contact on list with custom fields
    const contactRes = await fetch(`https://emailoctopus.com/api/1.6/lists/${listId}/contacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: EMAILOCTOPUS_API_KEY,
        email_address: email,
        fields: fields,
        status: 'SUBSCRIBED',
      }),
    });

    const contactData = await contactRes.json();
    const memberId = contactData.id;

    if (!memberId) {
      // Contact may already exist — try to find by email
      console.warn('Email Octopus: could not create contact, may already exist:', contactData);
      return;
    }

    // Step 2: Trigger the automation for this contact
    if (automationId) {
      const autoRes = await fetch(`https://emailoctopus.com/api/1.6/automations/${automationId}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: EMAILOCTOPUS_API_KEY,
          list_member_id: memberId,
        }),
      });
      const autoData = await autoRes.json();
      console.log(`Email Octopus: automation ${automationId} triggered for ${email}`, autoData);
    }

  } catch (err) {
    console.error('Email Octopus error:', err.message);
    // Non-blocking — payment processing continues even if email fails
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform Access — Set Cerebrum Properties
// ─────────────────────────────────────────────────────────────────────────────

// Sets the legacy properties that Cerebrum reads for access control:
// subscription_type, subscription_status, expiration_date
// Returns { isNewUser, contactEmail, contactFirstName } for email trigger
async function setPlatformAccess(contactId, plan, interval) {
  const subscriptionType = PLAN_TO_SUBSCRIPTION_TYPE[plan] || 'Academic';
  const expirationDate = calculateExpirationDate(interval);

  try {
    // Read current contact to check if new user
    const contact = await hubspotClient.crm.contacts.basicApi.getById(
      contactId,
      ['subscription_status', 'email', 'firstname']
    );

    const currentStatus = contact.properties.subscription_status;
    const isNewUser = !currentStatus || currentStatus === 'None' || currentStatus === '';

    const platformProps = {
      subscription_type: subscriptionType,
      expiration_date: expirationDate,
    };

    if (isNewUser) {
      // New user: Enrollment triggers Cerebrum to create account
      // Cerebrum sends back USER_REGISTERED with activation link
      // Existing enrollment workflow handles the password-setup email
      platformProps.subscription_status = 'Enrollment';
    } else {
      // Existing user: just update type and expiration
      platformProps.subscription_status = 'Active';
    }

    await hubspotClient.crm.contacts.basicApi.update(contactId, {
      properties: platformProps,
    });

    console.log(`Platform access: type=${subscriptionType}, status=${platformProps.subscription_status}, expires=${expirationDate}`);

    return {
      isNewUser,
      contactEmail: contact.properties.email || '',
      contactFirstName: contact.properties.firstname || '',
    };

  } catch (err) {
    console.error(`Failed to set platform access for contact ${contactId}:`, err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Payment Paid
// ─────────────────────────────────────────────────────────────────────────────

async function handlePaid(payment, metadata) {
  const { dealId, contactId, plan, interval, vatTreatment, currency } = metadata;
  const isRecurring = payment.sequenceType === 'recurring';
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  if (isRecurring) {
    // ── Recurring payment (subscription charge) ──
    console.log(`Recurring payment ${payment.id} paid for deal ${dealId}`);

    // Extend platform expiration
    const expirationDate = calculateExpirationDate(interval);

    try {
      await hubspotClient.crm.contacts.basicApi.update(contactId, {
        properties: {
          last_subscription_payment_date: today,
          last_mollie_payment_id: payment.id,
          needs_payment_retry: 'false',
          expiration_date: expirationDate,
        },
      });
    } catch (err) {
      console.error(`Failed to update contact ${contactId} for recurring payment:`, err.message);
    }

    // Create renewal invoice
    const invoiceResult = await createHubSpotInvoice(payment, metadata, contactId);
    if (invoiceResult) {
      console.log(`Renewal invoice: ${invoiceResult.invoiceNumber}`);
    }

  } else {
    // ── First payment (initial checkout) ──
    console.log(`First payment ${payment.id} paid for deal ${dealId}`);

    const paymentMethod = PAYMENT_METHOD_MAP[payment.method] || 'other';

    // Update deal: mark as paid
    try {
      await hubspotClient.crm.deals.basicApi.update(dealId, {
        properties: {
          payment_status: 'paid',
          initial_payment_date: today,
          deal_payment_method: paymentMethod,
        },
      });
    } catch (err) {
      console.error(`Failed to update deal ${dealId}:`, err.message);
    }

    // Create HubSpot invoice (auto-numbered DA-2026-NNNN)
    const invoiceResult = await createHubSpotInvoice(payment, metadata, contactId);

    // Store invoice number + link on deal (for WF1 email template)
    if (invoiceResult) {
      try {
        await hubspotClient.crm.deals.basicApi.update(dealId, {
          properties: {
            invoice_number: invoiceResult.invoiceNumber,
            invoice_link: invoiceResult.invoiceLink,
          },
        });
      } catch (err) {
        console.error(`Failed to store invoice link on deal ${dealId}:`, err.message);
      }
    }

    // Set platform access (subscription_type, subscription_status, expiration_date)
    const accessResult = await setPlatformAccess(contactId, plan, interval);

    // Trigger confirmation email via Email Octopus
    if (accessResult) {
      await triggerEmailOctopus(OCTOPUS_LIST_PAID, OCTOPUS_AUTOMATION_PAID, accessResult.contactEmail, {
        FirstName: accessResult.contactFirstName,
        Plan: plan,
        Interval: interval,
        Amount: payment.amount?.value || '',
        Currency: payment.amount?.currency || 'EUR',
        InvoiceNumber: invoiceResult?.invoiceNumber || '',
        InvoiceLink: invoiceResult?.invoiceLink || '',
        IsNewUser: accessResult.isNewUser ? 'yes' : 'no',
      });
    }

    // Create Mollie subscription for recurring charges
    const isSubscription = interval === 'monthly' || interval === 'annual';

    if (isSubscription && payment.mandateId) {
      await createSubscription(payment, metadata);
    } else if (!isSubscription) {
      // One-time payment — close deal
      try {
        await hubspotClient.crm.deals.basicApi.update(dealId, {
          properties: { dealstage: STAGES.CLOSED_WON_ONETIME },
        });
      } catch (err) {
        console.error(`Failed to close deal ${dealId} as one-time:`, err.message);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Create Mollie Subscription (after first payment succeeds)
// ─────────────────────────────────────────────────────────────────────────────

async function createSubscription(payment, metadata) {
  const { dealId, contactId, plan, interval } = metadata;

  try {
    const subscription = await mollieClient.customerSubscriptions.create({
      customerId: payment.customerId,
      amount: payment.amount,
      interval: SUBSCRIPTION_INTERVALS[interval],
      description: `Disease Atlas — ${plan} subscription`,
      webhookUrl: 'https://mollie-hubspot-backend-v4.vercel.app/api/mollie-webhook',
      metadata: { dealId, contactId, plan, interval },
    });

    console.log(`Subscription ${subscription.id} created for customer ${payment.customerId}`);

    // Update deal with subscription info and close as won
    await hubspotClient.crm.deals.basicApi.update(dealId, {
      properties: {
        mollie_subscription_id: subscription.id,
        dealstage: STAGES.CLOSED_WON_SUBSCRIPTION,
      },
    });

    // Update contact with subscription tracking properties
    await hubspotClient.crm.contacts.basicApi.update(contactId, {
      properties: {
        billing_subscription_active: 'true',
        billing_subscription_status: 'active',
        billing_subscription_plan: plan,
        billing_subscription_interval: interval,
        mollie_subscription_id: subscription.id,
        billing_start_date: new Date().toISOString(),
        billing_country: payment.metadata.country || '',
        billing_vat_id: payment.metadata.vatId || '',
        billing_vat_treatment: payment.metadata.vatTreatment || '',
        next_subscription_payment: subscription.nextPaymentDate || '',
        last_subscription_payment_date: new Date().toISOString().split('T')[0],
        last_mollie_payment_id: payment.id,
      },
    });

  } catch (err) {
    console.error(`Failed to create subscription for deal ${dealId}:`, err.message);
    // Payment succeeded but subscription creation failed — flag for manual follow-up
    await hubspotClient.crm.deals.basicApi.update(dealId, {
      properties: {
        payment_status: 'paid',
        dealstage: STAGES.CLOSED_WON_SUBSCRIPTION,
      },
    }).catch(e => console.error('Failed to update deal after subscription error:', e.message));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Payment Failed / Canceled / Expired
// ─────────────────────────────────────────────────────────────────────────────

async function handleFailed(payment, metadata) {
  const { dealId, contactId, plan } = metadata;
  const isRecurring = payment.sequenceType === 'recurring';

  console.log(`Payment ${payment.id} ${payment.status} for deal ${dealId} (recurring: ${isRecurring})`);

  if (isRecurring) {
    // ── Failed recurring payment ──
    // Set flag for dunning workflow (HubSpot WF2B)
    try {
      await hubspotClient.crm.contacts.basicApi.update(contactId, {
        properties: {
          needs_payment_retry: 'true',
          last_mollie_payment_id: payment.id,
        },
      });
    } catch (err) {
      console.error(`Failed to flag contact ${contactId} for dunning:`, err.message);
    }
  } else {
    // ── Failed first payment ──
    // Move deal to Lost stage
    try {
      await hubspotClient.crm.deals.basicApi.update(dealId, {
        properties: {
          payment_status: payment.status, // "failed", "canceled", "expired"
          dealstage: STAGES.LOST_PAYMENT_FAILED,
        },
      });
    } catch (err) {
      console.error(`Failed to update deal ${dealId} to lost:`, err.message);
    }

    // Trigger failure email via Email Octopus
    try {
      const contact = await hubspotClient.crm.contacts.basicApi.getById(
        contactId,
        ['email', 'firstname']
      );
      await triggerEmailOctopus(OCTOPUS_LIST_FAILED, OCTOPUS_AUTOMATION_FAILED, contact.properties.email, {
        FirstName: contact.properties.firstname || '',
        Plan: plan || '',
      });
    } catch (err) {
      console.error(`Failed to trigger failure email for contact ${contactId}:`, err.message);
    }
  }
}
