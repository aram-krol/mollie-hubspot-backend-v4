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

// Server-side price table (must match create-checkout.js)
const PRICE_TABLE = {
  'academic-pro':  { monthly: { EUR: '135.00', USD: '150.00' }, annual: { EUR: '1200.00', USD: '1320.00' } },
  'academic-team': { monthly: { EUR: '270.00', USD: '300.00' }, annual: { EUR: '2400.00', USD: '2640.00' } },
  'professional':  { monthly: { EUR: '400.00', USD: '440.00' }, annual: { EUR: '3600.00', USD: '3960.00' } },
};

// Human-readable plan labels for invoice line items
const PLAN_LABELS = {
  'academic-pro': 'Academic Pro',
  'academic-team': 'Academic Team',
  'professional': 'Professional',
};

// HubSpot product IDs (kept for reference — not used for invoice line items
// because HubSpot products with recurring billing frequency block invoice finalization)
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
const OCTOPUS_LIST_RECURRING_FAILED = process.env.OCTOPUS_LIST_RECURRING_FAILED || '';
const OCTOPUS_AUTOMATION_RECURRING_FAILED = process.env.OCTOPUS_AUTOMATION_RECURRING_FAILED || '';
const OCTOPUS_LIST_INTERNAL = process.env.OCTOPUS_LIST_INTERNAL || '';
const OCTOPUS_AUTOMATION_INTERNAL = process.env.OCTOPUS_AUTOMATION_INTERNAL || '';

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

    // ── Mandate-update payments (from /api/update-payment-method) ──
    if (metadata.type === 'mandate-update') {
      if (payment.status === 'paid') {
        await handleMandateUpdate(payment, metadata);
      } else {
        console.log(`Mandate-update payment ${paymentId} status: ${payment.status} — no action`);
      }
      return res.status(200).end();
    }

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
    // Fetch contact details for recipient info on invoice
    let contactName = '';
    let contactCompany = '';
    let contactCountry = metadata.country || '';
    try {
      const contactInfo = await hubspotClient.crm.contacts.basicApi.getById(
        contactId, ['firstname', 'lastname', 'company']
      );
      const fn = contactInfo.properties.firstname || '';
      const ln = contactInfo.properties.lastname || '';
      contactName = `${fn} ${ln}`.trim();
      contactCompany = contactInfo.properties.company || '';
    } catch (err) {
      console.warn('Could not fetch contact info for invoice:', err.message);
    }

    const invoiceProps = {
      hs_currency: currency || 'EUR',
      hs_invoice_date: today,
      hs_due_date: dueDate.toISOString().split('T')[0],
      hs_invoice_status: 'draft',
      customer_vat_id: metadata.vatId || '',
      vat_note: getVatNote(vatTreatment),
      subscription_period: getSubscriptionPeriod(interval),
      hs_recipient_company_country_code: contactCountry,
      hs_recipient_company_country: contactCountry,
      hs_external_recipient: contactCompany || contactName,
    };

    const invoiceRes = await hubspotClient.apiRequest({
      method: 'POST',
      path: '/crm/v3/objects/invoices',
      body: { properties: invoiceProps },
    });

    const invoiceData = await invoiceRes.json();
    const invoiceId = invoiceData.id;
    if (!invoiceId) {
      console.error('HubSpot invoice creation returned no ID:', invoiceData);
      return null;
    }

    // Step 2a: Associate invoice with contact
    await hubspotClient.apiRequest({
      method: 'PUT',
      path: `/crm/v4/objects/invoices/${invoiceId}/associations/default/contacts/${contactId}`,
    });

    // Step 2b: Associate invoice with deal (if dealId present — mandate-update invoices have no deal)
    const { dealId } = metadata;
    if (dealId) {
      try {
        await hubspotClient.apiRequest({
          method: 'PUT',
          path: `/crm/v4/objects/invoices/${invoiceId}/associations/default/deals/${dealId}`,
        });
      } catch (err) {
        console.warn(`Could not associate invoice ${invoiceId} with deal ${dealId}:`, err.message);
        // Non-blocking — invoice is still created and linked to contact
      }
    }

    // Step 3: Create line item with explicit properties (not from product catalog)
    // HubSpot products are configured as recurring, which blocks invoice finalization.
    // Instead, create a one-time line item with explicit name, price, and quantity.
    // VAT is added via hs_tax to show the correct total on the invoice.
    const unitPrice = PRICE_TABLE[plan]?.[interval]?.[currency || 'EUR'];
    const planLabel = PLAN_LABELS[plan] || plan;
    const intervalLabel = interval === 'annual' ? 'Annual' : 'Monthly';
    const vatRateNum = parseFloat(metadata.vatRate) || 0;
    const vatAmountNum = parseFloat(metadata.vatAmount) || 0;

    if (unitPrice) {
      // Line item 1: Subscription
      const lineItemRes = await hubspotClient.apiRequest({
        method: 'POST',
        path: '/crm/v3/objects/line_items',
        body: {
          properties: {
            name: `Disease Atlas ${planLabel} — ${intervalLabel} subscription`,
            hs_sku: `DA-${plan}-${interval}`,
            quantity: '1',
            price: unitPrice,
          },
        },
      });
      const lineItemData = await lineItemRes.json();

      if (lineItemData.id) {
        await hubspotClient.apiRequest({
          method: 'PUT',
          path: `/crm/v4/objects/invoices/${invoiceId}/associations/default/line_items/${lineItemData.id}`,
        });
      } else {
        console.warn('Line item creation returned no ID:', lineItemData);
      }

      // Line item 2: VAT (only for standard VAT — not reverse charge or export)
      if (vatRateNum > 0 && vatTreatment === 'standard') {
        const vatLineRes = await hubspotClient.apiRequest({
          method: 'POST',
          path: '/crm/v3/objects/line_items',
          body: {
            properties: {
              name: `VAT ${vatRateNum}%`,
              quantity: '1',
              price: vatAmountNum.toFixed(2),
            },
          },
        });
        const vatLineData = await vatLineRes.json();

        if (vatLineData.id) {
          await hubspotClient.apiRequest({
            method: 'PUT',
            path: `/crm/v4/objects/invoices/${invoiceId}/associations/default/line_items/${vatLineData.id}`,
          });
        }
      }
    } else {
      console.warn(`No price found for ${plan}/${interval}/${currency} — invoice has no line items`);
    }

    // Step 4: Move invoice from draft to open (finalize)
    // HubSpot assigns a sequential number and publishes the hosted URL on finalization.
    // If this fails (e.g., missing sender info), the invoice stays in draft.
    const finalizeRes = await hubspotClient.apiRequest({
      method: 'PATCH',
      path: `/crm/v3/objects/invoices/${invoiceId}`,
      body: {
        properties: { hs_invoice_status: 'open' },
      },
    });
    const finalizeData = await finalizeRes.json();
    if (finalizeData.properties?.hs_invoice_status !== 'open') {
      console.warn(`Invoice ${invoiceId} finalization may have failed. Status: ${finalizeData.properties?.hs_invoice_status}`, JSON.stringify(finalizeData));
    }

    // Step 5: Read back to get auto-assigned invoice number and link
    const readRes = await hubspotClient.apiRequest({
      method: 'GET',
      path: `/crm/v3/objects/invoices/${invoiceId}?properties=hs_invoice_link,hs_number,hs_invoice_status`,
    });
    const readData = await readRes.json();

    const invoiceNumber = readData.properties?.hs_number || '';
    const invoiceLink = readData.properties?.hs_invoice_link || '';
    const invoiceStatus = readData.properties?.hs_invoice_status || '';
    if (invoiceStatus !== 'open') {
      console.warn(`Invoice ${invoiceId} is still "${invoiceStatus}" after finalization attempt. Number: ${invoiceNumber}, Link: ${invoiceLink}`);
    }

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
    // Step 1: Add contact to list (or update if already exists)
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
    let memberId = contactData.id;

    // If contact already exists on list, look up by MD5 hash of email
    // This happens on recurring payments — same subscriber, new invoice
    if (!memberId) {
      const crypto = require('crypto');
      const emailHash = crypto.createHash('md5').update(email.toLowerCase()).digest('hex');

      try {
        // Update existing contact's fields with new data (e.g., new InvoiceNumber)
        const updateRes = await fetch(`https://emailoctopus.com/api/1.6/lists/${listId}/contacts/${emailHash}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: EMAILOCTOPUS_API_KEY,
            fields: fields,
            status: 'SUBSCRIBED',
          }),
        });
        const updateData = await updateRes.json();
        memberId = updateData.id || emailHash;
        console.log(`Email Octopus: updated existing contact ${email} on list ${listId}`);
      } catch (err) {
        console.warn(`Email Octopus: could not update existing contact ${email}:`, err.message);
        return;
      }
    }

    // Step 2: Trigger the automation for this contact
    if (automationId && memberId) {
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

// Sends an internal team notification via Email Octopus.
// Uses a dedicated "DA Internal Notifications" list with billing@euretos.com as sole subscriber.
// Since the same address receives every notification, triggerEmailOctopus handles re-trigger
// by updating fields (PUT) and re-queuing the automation.
//
// If Email Octopus suppresses re-queued automations for the same contact, switch to
// a simple SMTP/SendGrid call or HubSpot timeline event instead.
async function notifyInternal(eventType, contactEmail, fields) {
  if (!OCTOPUS_LIST_INTERNAL) return;
  try {
    await triggerEmailOctopus(OCTOPUS_LIST_INTERNAL, OCTOPUS_AUTOMATION_INTERNAL, 'billing@euretos.com', {
      EventType: eventType,
      ContactEmail: contactEmail || '',
      ...fields,
    });
  } catch (err) {
    console.error(`Internal notification failed (${eventType}):`, err.message);
  }
}

// Removes a contact from an Email Octopus list by email address.
// Used to stop dunning email drip after successful payment recovery.
async function removeFromEmailOctopusList(listId, email) {
  if (!EMAILOCTOPUS_API_KEY || !listId || !email) return;

  try {
    // Email Octopus uses MD5 hash of lowercase email as the member ID for lookup
    const crypto = require('crypto');
    const memberId = crypto.createHash('md5').update(email.toLowerCase()).digest('hex');

    const res = await fetch(`https://emailoctopus.com/api/1.6/lists/${listId}/contacts/${memberId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: EMAILOCTOPUS_API_KEY }),
    });

    if (res.ok) {
      console.log(`Email Octopus: removed ${email} from list ${listId}`);
    } else {
      const data = await res.json();
      console.warn(`Email Octopus: could not remove ${email} from list ${listId}:`, data);
    }
  } catch (err) {
    console.error('Email Octopus removal error:', err.message);
    // Non-blocking
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

    // Send renewal confirmation + invoice email via Email Octopus
    if (invoiceResult) {
      try {
        const contact = await hubspotClient.crm.contacts.basicApi.getById(
          contactId,
          ['email', 'firstname']
        );
        await triggerEmailOctopus(OCTOPUS_LIST_PAID, OCTOPUS_AUTOMATION_PAID, contact.properties.email, {
          FirstName: contact.properties.firstname || '',
          Plan: plan || '',
          Interval: interval || '',
          Amount: payment.amount?.value || '',
          Currency: payment.amount?.currency || 'EUR',
          InvoiceNumber: invoiceResult.invoiceNumber,
          InvoiceLink: invoiceResult.invoiceLink,
          IsNewUser: 'no',
        });
      } catch (err) {
        console.error(`Failed to send renewal email for contact ${contactId}:`, err.message);
      }
    } else {
      console.warn(`Skipping renewal email for contact ${contactId}: no invoice created`);
    }

    // Internal notification
    await notifyInternal('Renewal', '', {
      Plan: plan || '', InvoiceNumber: invoiceResult?.invoiceNumber || '',
      InvoiceLink: invoiceResult?.invoiceLink || '',
    });

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
    // Only send when invoice is ready — if invoice creation failed, the customer
    // should not receive a half-complete email. WF1 internal notification still
    // fires (on payment_status=paid), so the team knows and can follow up.
    let emailSent = false;
    if (accessResult && invoiceResult) {
      try {
        await triggerEmailOctopus(OCTOPUS_LIST_PAID, OCTOPUS_AUTOMATION_PAID, accessResult.contactEmail, {
          FirstName: accessResult.contactFirstName,
          Plan: plan,
          Interval: interval,
          Amount: payment.amount?.value || '',
          Currency: payment.amount?.currency || 'EUR',
          InvoiceNumber: invoiceResult.invoiceNumber,
          InvoiceLink: invoiceResult.invoiceLink,
          IsNewUser: accessResult.isNewUser ? 'yes' : 'no',
        });
        emailSent = true;
      } catch (err) {
        console.error(`Failed to trigger confirmation email for deal ${dealId}:`, err.message);
      }
    } else {
      console.warn(`Skipping confirmation email for deal ${dealId}: invoice=${!!invoiceResult}, access=${!!accessResult}`);
    }

    // Track email send status on deal for monitoring
    // HubSpot active list "payment_status=paid AND confirmation_email_sent!=true" catches failures
    try {
      await hubspotClient.crm.deals.basicApi.update(dealId, {
        properties: {
          confirmation_email_sent: emailSent ? 'true' : 'false',
        },
      });
    } catch (err) {
      console.error(`Failed to update confirmation_email_sent on deal ${dealId}:`, err.message);
    }

    // Internal notification
    await notifyInternal('New Payment', accessResult?.contactEmail || '', {
      Plan: plan || '', InvoiceNumber: invoiceResult?.invoiceNumber || '',
      InvoiceLink: invoiceResult?.invoiceLink || '',
    });

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
        billing_subscription_plan: plan.replace(/-/g, '_'),
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
  const { dealId, contactId, plan, interval } = metadata;
  const isRecurring = payment.sequenceType === 'recurring';

  console.log(`Payment ${payment.id} ${payment.status} for deal ${dealId} (recurring: ${isRecurring})`);

  // ── Extract failure reason ──
  const failureReason = payment.details?.failureReason || payment.details?.bankReasonCode || '';
  const failureMessage = payment.details?.failureMessage || getHumanFailureMessage(failureReason);

  if (isRecurring) {
    // ── Failed recurring payment — full dunning handling ──

    // Step 1: Check if Mollie has canceled the subscription
    let subscriptionCanceled = false;
    const subscriptionId = payment.subscriptionId;
    const customerId = payment.customerId;

    if (subscriptionId && customerId) {
      try {
        const subscription = await mollieClient.customerSubscriptions.get(subscriptionId, {
          customerId: customerId,
        });
        subscriptionCanceled = subscription.status === 'canceled';
        console.log(`Subscription ${subscriptionId} status: ${subscription.status}`);
      } catch (err) {
        console.warn(`Could not check subscription ${subscriptionId} status:`, err.message);
      }
    }

    // Step 2: Update HubSpot contact with failure info
    try {
      // Get current failure count
      const contact = await hubspotClient.crm.contacts.basicApi.getById(
        contactId,
        ['billing_failure_count', 'email', 'firstname', 'mollie_subscription_id']
      );
      const currentCount = parseInt(contact.properties.billing_failure_count || '0', 10);

      // 14-day grace period: override expiration_date regardless of billing interval
      // Monthly: natural buffer is ~5 days, this extends to 14
      // Annual: natural buffer could be months, this caps at 14
      const graceDate = new Date();
      graceDate.setDate(graceDate.getDate() + 14);
      const graceDateStr = graceDate.toISOString().split('T')[0];

      const updateProps = {
        needs_payment_retry: 'true',
        last_mollie_payment_id: payment.id,
        billing_failure_reason: failureReason,
        billing_failure_message: failureMessage,
        billing_failure_count: String(currentCount + 1),
        subscription_status: 'Past_Due',    // Distinct from Suspended (password lockout)
        expiration_date: graceDateStr,       // 14-day grace period from today
      };

      // If Mollie canceled the subscription, override to Expired (not Past_Due)
      if (subscriptionCanceled) {
        updateProps.billing_subscription_active = 'false';
        updateProps.billing_subscription_status = 'canceled';
        updateProps.subscription_status = 'Expired';  // No recovery possible — must resubscribe
      }

      await hubspotClient.crm.contacts.basicApi.update(contactId, {
        properties: updateProps,
      });

      // Step 3: Generate update-payment-method link (only if subscription still active)
      let updatePaymentLink = '';
      if (!subscriptionCanceled && subscriptionId) {
        // Build the link — the frontend page will POST to /api/update-payment-method
        updatePaymentLink = `https://www.euretos.com/update-payment-method?email=${encodeURIComponent(contact.properties.email)}&sid=${encodeURIComponent(subscriptionId)}`;
      }

      // Step 4: Trigger Email Octopus for recurring failure
      await triggerEmailOctopus(
        OCTOPUS_LIST_RECURRING_FAILED,
        OCTOPUS_AUTOMATION_RECURRING_FAILED,
        contact.properties.email,
        {
          FirstName: contact.properties.firstname || '',
          Plan: plan || '',
          FailureReason: failureReason,
          FailureMessage: failureMessage,
          SubscriptionCanceled: subscriptionCanceled ? 'true' : 'false',
          UpdatePaymentLink: updatePaymentLink,
        }
      );

      // Internal notification
      await notifyInternal(
        subscriptionCanceled ? 'Subscription Canceled' : 'Recurring Payment Failed',
        contact.properties.email,
        { Plan: plan || '', FailureReason: failureReason }
      );

    } catch (err) {
      console.error(`Failed to handle recurring failure for contact ${contactId}:`, err.message);
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
      // Internal notification
      await notifyInternal('First Payment Failed', contact.properties.email, {
        Plan: plan || '',
      });
    } catch (err) {
      console.error(`Failed to trigger failure email for contact ${contactId}:`, err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Human-Readable Failure Messages
// ─────────────────────────────────────────────────────────────────────────────

function getHumanFailureMessage(reason) {
  const messages = {
    // Card failure reasons
    expired_card: 'Your card has expired. Please update your payment method.',
    insufficient_funds: 'Insufficient funds. Please ensure your account has enough balance or use a different card.',
    card_declined: 'Your card was declined. Please try a different card or contact your bank.',
    invalid_card_number: 'The card number is invalid. Please update your payment method.',
    authentication_failed: 'Card authentication failed. Please try again or use a different card.',
    possible_fraud: 'Your bank flagged this transaction. Please contact your bank, then update your payment method.',
    refused_by_issuer: 'Your bank declined this payment. Please contact your bank or use a different card.',
    // SEPA failure codes
    AC01: 'The bank account has been closed or is incorrect.',
    AC04: 'The bank account has been closed.',
    MD07: 'The account holder is deceased.',
    MS02: 'The payment was declined by the bank.',
    AM04: 'Insufficient funds in the bank account.',
    MS03: 'The payment was declined (reason not specified).',
  };
  return messages[reason] || 'Your payment could not be processed.';
}

// ─────────────────────────────────────────────────────────────────────────────
// Mandate Update Handler (from /api/update-payment-method)
// ─────────────────────────────────────────────────────────────────────────────

// When a customer updates their payment method after a failed recurring payment,
// the new "first" payment creates a new mandate. This handler:
// 1. Updates the subscription to use the new mandate
// 2. Clears the dunning state on the HubSpot contact
// 3. Creates an invoice for the recovered payment
// 4. Sends a confirmation email

async function handleMandateUpdate(payment, metadata) {
  const { subscriptionId, contactId, plan, interval, vatTreatment, currency, vatId, country } = metadata;

  console.log(`Mandate-update payment ${payment.id} paid — updating subscription ${subscriptionId}`);

  const newMandateId = payment.mandateId;
  const customerId = payment.customerId;

  // Step 1: Update the Mollie subscription with the new mandate
  if (subscriptionId && customerId && newMandateId) {
    try {
      await mollieClient.customerSubscriptions.update(subscriptionId, {
        customerId: customerId,
        mandateId: newMandateId,
      });
      console.log(`Subscription ${subscriptionId} updated with new mandate ${newMandateId}`);
    } catch (err) {
      console.error(`Failed to update subscription ${subscriptionId} mandate:`, err.message);
      // Continue — the payment succeeded, we should still update HubSpot
    }
  }

  // Step 2: Update HubSpot contact — clear dunning state, restore Active, extend expiration
  const expirationDate = calculateExpirationDate(interval);
  const today = new Date().toISOString().split('T')[0];

  try {
    await hubspotClient.crm.contacts.basicApi.update(contactId, {
      properties: {
        needs_payment_retry: 'false',
        billing_failure_reason: '',
        billing_failure_message: '',
        billing_failure_count: '0',
        billing_subscription_active: 'true',
        billing_subscription_status: 'active',
        subscription_status: 'Active',           // Restore from Past_Due
        expiration_date: expirationDate,          // Restore proper interval (35d or 1yr)
        last_subscription_payment_date: today,
        last_mollie_payment_id: payment.id,
      },
    });
  } catch (err) {
    console.error(`Failed to update contact ${contactId} after mandate update:`, err.message);
  }

  // Step 2b: Remove contact from Email Octopus dunning list to stop the email drip
  try {
    const contact = await hubspotClient.crm.contacts.basicApi.getById(contactId, ['email']);
    await removeFromEmailOctopusList(OCTOPUS_LIST_RECURRING_FAILED, contact.properties.email);
  } catch (err) {
    console.error(`Failed to remove contact ${contactId} from dunning list:`, err.message);
  }

  // Step 3: Create HubSpot invoice for the recovered payment
  const invoiceResult = await createHubSpotInvoice(payment, {
    ...metadata,
    // Ensure invoice has the right metadata even without a dealId
  }, contactId);

  if (invoiceResult) {
    console.log(`Recovery invoice: ${invoiceResult.invoiceNumber}`);
  }

  // Step 4: Trigger confirmation email via Email Octopus (only if invoice ready)
  if (invoiceResult) {
    try {
      const contact = await hubspotClient.crm.contacts.basicApi.getById(contactId, ['email', 'firstname']);
      await triggerEmailOctopus(OCTOPUS_LIST_PAID, OCTOPUS_AUTOMATION_PAID, contact.properties.email, {
        FirstName: contact.properties.firstname || '',
        Plan: plan || '',
        Interval: interval || '',
        Amount: payment.amount?.value || '',
        Currency: payment.amount?.currency || 'EUR',
        InvoiceNumber: invoiceResult.invoiceNumber,
        InvoiceLink: invoiceResult.invoiceLink,
        IsNewUser: 'no',
      });
    } catch (err) {
      console.error(`Failed to trigger confirmation email after mandate update:`, err.message);
    }
  } else {
    console.warn(`Skipping recovery confirmation email for contact ${contactId}: no invoice created`);
  }

  // Internal notification
  await notifyInternal('Payment Recovered', '', {
    Plan: plan || '', InvoiceNumber: invoiceResult?.invoiceNumber || '',
    InvoiceLink: invoiceResult?.invoiceLink || '',
  });
}
