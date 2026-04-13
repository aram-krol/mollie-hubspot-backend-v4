// /api/update-payment-method.js
// Disease Atlas — Payment Method Update Endpoint
//
// When a recurring payment fails (e.g., expired card), the customer receives
// a dunning email with a link to update their payment method. This endpoint:
//   1. Validates the request (email must match the subscription owner)
//   2. Retrieves the overdue amount from the last failed payment
//   3. Creates a new Mollie payment with sequenceType "first" (creates a new mandate)
//   4. Returns the Mollie checkout URL
//
// On successful payment, the webhook receives the callback and:
//   - Updates the subscription's mandateId to the new mandate
//   - Clears needs_payment_retry
//   - Extends expiration_date
//   - Creates a HubSpot invoice for the recovered amount
//
// Architecture doc: Section 10 (Dunning & Failed Payment Recovery)

const { createMollieClient } = require('@mollie/api-client');
const hubspot = require('@hubspot/api-client');

const mollieClient = createMollieClient({ apiKey: process.env.MOLLIE_API_KEY });
const hubspotClient = new hubspot.Client({ accessToken: process.env.HUBSPOT_PRIVATE_APP_TOKEN });

// CORS — same origins as create-checkout
const ALLOWED_ORIGINS = [
  'https://www.euretos.com',
  'https://euretos.com',
  'https://ask.euretos.com',
];

module.exports = async function handler(req, res) {
  // ── CORS headers ──
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { email, subscriptionId } = req.body;

    // ── Input validation ──
    if (!email || !subscriptionId) {
      return res.status(400).json({ error: 'Missing required fields: email, subscriptionId' });
    }

    // ── Look up HubSpot contact by email to get Mollie customer info ──
    const searchRes = await hubspotClient.crm.contacts.searchApi.doSearch({
      filterGroups: [{
        filters: [{ propertyName: 'email', operator: 'EQ', value: email }],
      }],
      properties: [
        'email', 'firstname', 'lastname',
        'mollie_subscription_id', 'billing_subscription_plan',
        'billing_subscription_interval', 'billing_vat_treatment',
        'billing_currency', 'billing_country', 'billing_vat_id',
        'last_mollie_payment_id',
      ],
      limit: 1,
    });

    if (!searchRes.results || searchRes.results.length === 0) {
      return res.status(404).json({ error: 'No account found for this email address' });
    }

    const contact = searchRes.results[0];
    const contactId = contact.id;
    const props = contact.properties;

    // ── Verify the subscription belongs to this contact ──
    if (props.mollie_subscription_id !== subscriptionId) {
      return res.status(403).json({ error: 'Subscription does not match this account' });
    }

    // ── Get the last failed payment to determine the overdue amount ──
    const lastPaymentId = props.last_mollie_payment_id;
    let amount;
    let currency;

    if (lastPaymentId) {
      try {
        const lastPayment = await mollieClient.payments.get(lastPaymentId);
        amount = lastPayment.amount;
        currency = lastPayment.amount?.currency || 'EUR';
      } catch (err) {
        console.warn(`Could not retrieve last payment ${lastPaymentId}:`, err.message);
      }
    }

    // Fallback: if we can't get the failed payment amount, use subscription amount
    if (!amount) {
      try {
        // Need to find the customerId from an existing payment or subscription
        const payments = await mollieClient.payments.list({ limit: 5 });
        // Find a payment with matching subscription metadata
        for (const p of payments) {
          if (p.metadata?.contactId === contactId && p.subscriptionId === subscriptionId) {
            amount = p.amount;
            currency = p.amount?.currency || 'EUR';
            break;
          }
        }
      } catch (err) {
        console.warn('Could not retrieve subscription amount from payments:', err.message);
      }
    }

    if (!amount) {
      return res.status(500).json({ error: 'Could not determine payment amount. Please contact support.' });
    }

    // ── Find the Mollie customer ID ──
    // Search Mollie customers by email
    let mollieCustomerId;
    try {
      const customers = await mollieClient.customers.list({ limit: 250 });
      for (const c of customers) {
        if (c.email === email) {
          mollieCustomerId = c.id;
          break;
        }
      }
    } catch (err) {
      console.error('Failed to search Mollie customers:', err.message);
    }

    if (!mollieCustomerId) {
      return res.status(404).json({ error: 'No Mollie customer found for this email. Please contact support.' });
    }

    // ── Check that the subscription is still active in Mollie ──
    let subscription;
    try {
      subscription = await mollieClient.customerSubscriptions.get(subscriptionId, {
        customerId: mollieCustomerId,
      });
    } catch (err) {
      console.error(`Failed to get subscription ${subscriptionId}:`, err.message);
      return res.status(404).json({
        error: 'Subscription not found. It may have been canceled. Please resubscribe from the pricing page.',
      });
    }

    if (subscription.status === 'canceled') {
      return res.status(410).json({
        error: 'This subscription has been canceled by the payment provider. Please create a new subscription from the pricing page.',
        resubscribeUrl: 'https://www.euretos.com/pricing',
      });
    }

    // ── Create a new Mollie payment with sequenceType "first" ──
    // This creates a new mandate when the customer completes payment
    const plan = props.billing_subscription_plan || '';
    const interval = props.billing_subscription_interval || '';

    const payment = await mollieClient.payments.create({
      amount: amount,
      description: `Disease Atlas — Payment method update (${plan})`,
      redirectUrl: 'https://www.euretos.com/payment-complete',
      webhookUrl: 'https://mollie-hubspot-backend-v4.vercel.app/api/mollie-webhook',
      sequenceType: 'first',
      customerId: mollieCustomerId,
      metadata: {
        type: 'mandate-update',
        subscriptionId: subscriptionId,
        contactId: contactId,
        plan: plan,
        interval: interval,
        vatTreatment: props.billing_vat_treatment || '',
        currency: currency,
        vatId: props.billing_vat_id || '',
        country: props.billing_country || '',
        // No dealId — mandate updates don't create new deals
      },
    });

    console.log(`Mandate-update payment ${payment.id} created for customer ${mollieCustomerId}, subscription ${subscriptionId}`);

    return res.status(200).json({
      checkoutUrl: payment._links?.checkout?.href || payment.getCheckoutUrl(),
    });

  } catch (err) {
    console.error('Update payment method error:', err);
    return res.status(500).json({ error: 'Failed to create payment update. Please try again or contact support.' });
  }
};
