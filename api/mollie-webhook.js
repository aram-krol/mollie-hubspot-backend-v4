// /api/mollie-webhook.js
// Disease Atlas — Mollie Webhook Handler
//
// Receives payment status notifications from Mollie.
// CRITICAL: Always verifies payment by calling back to Mollie API — never trusts POST body.
//
// Handles both:
//   - First payments (from create-checkout): updates deal, creates subscription if needed
//   - Recurring payments (from active subscriptions): updates contact payment tracking
//
// Design doc: wiki/architecture/direct-checkout-implementation.md
// HubSpot property map: wiki/architecture/hubspot-workflows.md

const { createMollieClient } = require('@mollie/api-client');
const hubspot = require('@hubspot/api-client');

const mollieClient = createMollieClient({ apiKey: process.env.MOLLIE_API_KEY });
const hubspotClient = new hubspot.Client({ accessToken: process.env.HUBSPOT_PRIVATE_APP_TOKEN });

// Euretos company record in HubSpot — stores the invoice counter
const EURETOS_COMPANY_ID = process.env.EURETOS_COMPANY_ID || ''; // Set in Vercel env vars

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
// Invoice Number Generation
// ─────────────────────────────────────────────────────────────────────────────

async function generateInvoiceNumber() {
  // Read current counter from the Euretos company record, increment, write back
  // Format: DA-YYYY-NNNN (e.g., DA-2026-0001)
  if (!EURETOS_COMPANY_ID) {
    console.warn('EURETOS_COMPANY_ID not set — skipping invoice number generation');
    return null;
  }

  try {
    const company = await hubspotClient.crm.companies.basicApi.getById(
      EURETOS_COMPANY_ID,
      ['last_invoice_number']
    );

    const lastNumber = parseInt(company.properties.last_invoice_number || '0', 10);
    const nextNumber = lastNumber + 1;
    const year = new Date().getFullYear();
    const invoiceNumber = `DA-${year}-${String(nextNumber).padStart(4, '0')}`;

    // Write incremented counter back to company record
    await hubspotClient.crm.companies.basicApi.update(EURETOS_COMPANY_ID, {
      properties: { last_invoice_number: String(nextNumber) },
    });

    console.log(`Invoice number generated: ${invoiceNumber} (counter: ${nextNumber})`);
    return invoiceNumber;
  } catch (err) {
    console.error('Failed to generate invoice number:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Payment Paid
// ─────────────────────────────────────────────────────────────────────────────

async function handlePaid(payment, metadata) {
  const { dealId, contactId, plan, interval } = metadata;
  const isRecurring = payment.sequenceType === 'recurring';
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  if (isRecurring) {
    // ── Recurring payment (subscription charge) ──
    // Update contact tracking properties — HubSpot WF2 sends receipt email
    console.log(`Recurring payment ${payment.id} paid for deal ${dealId}`);

    // Generate invoice number for the renewal
    const invoiceNumber = await generateInvoiceNumber();

    try {
      const contactProps = {
        last_subscription_payment_date: today,
        last_mollie_payment_id: payment.id,
        needs_payment_retry: 'false',
      };
      if (invoiceNumber) contactProps.last_invoice_number = invoiceNumber;

      await hubspotClient.crm.contacts.basicApi.update(contactId, {
        properties: contactProps,
      });
    } catch (err) {
      console.error(`Failed to update contact ${contactId} for recurring payment:`, err.message);
    }

  } else {
    // ── First payment (initial checkout) ──
    console.log(`First payment ${payment.id} paid for deal ${dealId}`);

    // Map Mollie payment method to HubSpot enum value
    // Map Mollie method names to HubSpot deal_payment_method enum values
    // HubSpot enum: card, ideal, sepa_direct_debit, paypal, apple_pay, google_pay, pay_by_bank, other
    const methodMap = {
      ideal: 'ideal',
      creditcard: 'card',
      banktransfer: 'sepa_direct_debit',
      directdebit: 'sepa_direct_debit',
      paypal: 'paypal',
      applepay: 'apple_pay',
      googlepay: 'google_pay',
      paybybank: 'pay_by_bank',
    };
    const paymentMethod = methodMap[payment.method] || 'other';

    // Generate invoice number
    const invoiceNumber = await generateInvoiceNumber();

    // Update deal: mark as paid + set invoice number
    try {
      const dealProps = {
        payment_status: 'paid',
        initial_payment_date: today,
        deal_payment_method: paymentMethod,
      };
      if (invoiceNumber) dealProps.invoice_number = invoiceNumber;

      await hubspotClient.crm.deals.basicApi.update(dealId, {
        properties: dealProps,
      });
    } catch (err) {
      console.error(`Failed to update deal ${dealId}:`, err.message);
    }

    // For subscriptions: create Mollie subscription for recurring charges
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
    // The payment succeeded even though subscription creation failed.
    // Mark deal as paid but flag for manual follow-up.
    await hubspotClient.crm.deals.basicApi.update(dealId, {
      properties: {
        payment_status: 'paid',
        dealstage: STAGES.CLOSED_WON_SUBSCRIPTION,
        // Subscription creation will need manual intervention
      },
    }).catch(e => console.error('Failed to update deal after subscription error:', e.message));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Payment Failed / Canceled / Expired
// ─────────────────────────────────────────────────────────────────────────────

async function handleFailed(payment, metadata) {
  const { dealId, contactId, interval } = metadata;
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
    // Move deal to Lost stage — HubSpot WF1 sends failure email
    try {
      await hubspotClient.crm.deals.basicApi.update(dealId, {
        properties: {
          payment_status: payment.status, // "failed", "canceled", "expired" — matches HubSpot enum
          dealstage: STAGES.LOST_PAYMENT_FAILED,
        },
      });
    } catch (err) {
      console.error(`Failed to update deal ${dealId} to lost:`, err.message);
    }
  }
}
