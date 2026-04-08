// /api/cancel-subscription.js
// Disease Atlas — Subscription Cancellation Endpoint
//
// Cancels a Mollie subscription and updates HubSpot contact + deal properties.
// Triggers HubSpot WF3 (cancellation email + team notification).
//
// Design doc: wiki/architecture/hubspot-workflows.md (WF3)

const { createMollieClient } = require('@mollie/api-client');
const hubspot = require('@hubspot/api-client');

const mollieClient = createMollieClient({ apiKey: process.env.MOLLIE_API_KEY });
const hubspotClient = new hubspot.Client({ accessToken: process.env.HUBSPOT_PRIVATE_APP_TOKEN });

// CORS — only allow requests from the Euretos website
const ALLOWED_ORIGINS = [
  'https://www.euretos.com',
  'https://euretos.com',
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

  if (!ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const { customerId, subscriptionId, contactId } = req.body;

    if (!customerId || !subscriptionId) {
      return res.status(400).json({ error: 'Missing required fields: customerId, subscriptionId' });
    }

    // ── Cancel subscription in Mollie ──
    await mollieClient.customerSubscriptions.cancel(subscriptionId, { customerId });
    console.log(`Subscription ${subscriptionId} canceled for customer ${customerId}`);

    // ── Update HubSpot contact ──
    // Setting billing_subscription_status to 'canceled' triggers HubSpot WF3
    if (contactId) {
      try {
        await hubspotClient.crm.contacts.basicApi.update(contactId, {
          properties: {
            billing_subscription_active: 'false',
            billing_subscription_status: 'canceled',
          },
        });
      } catch (err) {
        console.error(`Failed to update contact ${contactId}:`, err.message);
        // Non-fatal: subscription is already canceled in Mollie
      }
    }

    return res.status(200).json({ success: true, message: 'Subscription canceled' });

  } catch (err) {
    console.error('Cancel subscription error:', err);
    return res.status(500).json({ error: 'Failed to cancel subscription. Please try again.' });
  }
};
