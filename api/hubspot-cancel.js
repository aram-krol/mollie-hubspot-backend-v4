// /api/hubspot-cancel.js
// Disease Atlas — HubSpot Cancellation Webhook Handler
//
// Called by HubSpot WF3 when support sets cancel_subscription = Yes on a contact.
// HubSpot sends the contact payload via workflow "Send webhook" action.
//
// This endpoint:
//   1. Looks up the contact's Mollie subscription ID + customer ID
//   2. Cancels the Mollie subscription (no more recurring charges)
//   3. Updates HubSpot contact: billing_subscription_active=false, billing_subscription_status=canceled
//   4. Triggers Email Octopus "DA Subscription Canceled" automation
//   5. Leaves subscription_status and expiration_date untouched — customer keeps access until
//      their current paid period ends.
//
// Expected HubSpot webhook payload (from workflow "Send webhook" action):
//   Method: POST
//   Body: JSON with at minimum the contact object properties including:
//     - contactId (HubSpot vid)
//     - email
//     - mollie_subscription_id
//
// NOTE: HubSpot workflow webhooks don't natively include a signature. If this endpoint
// is exposed publicly, consider adding a shared-secret header check. For now, the
// endpoint relies on obscurity + allow-list in Vercel network rules.

const { createMollieClient } = require('@mollie/api-client');
const hubspot = require('@hubspot/api-client');

const mollieClient = createMollieClient({ apiKey: process.env.MOLLIE_API_KEY });
const hubspotClient = new hubspot.Client({ accessToken: process.env.HUBSPOT_PRIVATE_APP_TOKEN });

const EMAILOCTOPUS_API_KEY = process.env.EMAILOCTOPUS_API_KEY || '';
const OCTOPUS_LIST_CANCELED = process.env.OCTOPUS_LIST_CANCELED || '';
const OCTOPUS_AUTOMATION_CANCELED = process.env.OCTOPUS_AUTOMATION_CANCELED || '';

// Optional shared-secret header check for webhook auth
const HUBSPOT_WEBHOOK_SECRET = process.env.HUBSPOT_WEBHOOK_SECRET || '';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Optional shared-secret check — set X-Webhook-Secret header in the HubSpot workflow
  if (HUBSPOT_WEBHOOK_SECRET) {
    const provided = req.headers['x-webhook-secret'];
    if (provided !== HUBSPOT_WEBHOOK_SECRET) {
      console.warn('hubspot-cancel: invalid or missing X-Webhook-Secret header');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    // HubSpot workflow webhook payload — the structure depends on the mapping you define
    // in the workflow's "Send webhook" action. Expect at least contactId (HubSpot vid)
    // and the contact properties we need.
    const { contactId, email: bodyEmail, mollie_subscription_id: bodySubId } = req.body || {};

    // HubSpot sometimes wraps the payload — try to unwrap common shapes
    const payloadContactId = contactId || req.body?.vid || req.body?.objectId || req.body?.properties?.hs_object_id;

    if (!payloadContactId) {
      console.warn('hubspot-cancel: no contactId in payload', JSON.stringify(req.body));
      return res.status(400).json({ error: 'Missing contactId in webhook payload' });
    }

    // Always re-fetch the contact from HubSpot to get the latest properties
    // (don't trust the payload to have fresh values)
    let contact;
    try {
      contact = await hubspotClient.crm.contacts.basicApi.getById(payloadContactId, [
        'email', 'firstname', 'mollie_subscription_id',
        'billing_subscription_plan', 'billing_subscription_interval',
        'billing_subscription_status', 'billing_subscription_active',
        'expiration_date', 'cancel_subscription',
      ]);
    } catch (err) {
      console.error(`hubspot-cancel: contact ${payloadContactId} not found:`, err.message);
      return res.status(404).json({ error: 'Contact not found' });
    }

    const props = contact.properties;

    // Idempotency — if already canceled, skip Mollie cancel but still 200
    if (props.billing_subscription_status === 'canceled') {
      console.log(`hubspot-cancel: contact ${payloadContactId} already canceled — skipping`);
      return res.status(200).json({ success: true, message: 'Already canceled' });
    }

    const subscriptionId = props.mollie_subscription_id || bodySubId;

    if (!subscriptionId) {
      console.warn(`hubspot-cancel: contact ${payloadContactId} has no mollie_subscription_id`);
      // Not fatal — still update HubSpot + send email (support may be canceling a manual account)
    }

    // ── Step 1: Find Mollie customer ──
    let mollieCustomerId;
    if (subscriptionId) {
      try {
        const customers = await mollieClient.customers.list({ limit: 250 });
        for (const c of customers) {
          if (c.email === props.email) {
            mollieCustomerId = c.id;
            break;
          }
        }
      } catch (err) {
        console.error('hubspot-cancel: failed to find Mollie customer:', err.message);
      }
    }

    // ── Step 2: Cancel Mollie subscription ──
    if (subscriptionId && mollieCustomerId) {
      try {
        await mollieClient.customerSubscriptions.cancel(subscriptionId, { customerId: mollieCustomerId });
        console.log(`hubspot-cancel: Mollie subscription ${subscriptionId} canceled`);
      } catch (err) {
        // Already canceled, or not found — not fatal
        console.warn(`hubspot-cancel: Mollie cancel failed (may already be canceled):`, err.message);
      }
    }

    // ── Step 3: Update HubSpot contact ──
    // Keep subscription_status and expiration_date untouched — customer keeps platform
    // access until expiration_date passes naturally.
    try {
      await hubspotClient.crm.contacts.basicApi.update(payloadContactId, {
        properties: {
          billing_subscription_active: 'false',
          billing_subscription_status: 'canceled',
        },
      });
    } catch (err) {
      console.error(`hubspot-cancel: failed to update contact ${payloadContactId}:`, err.message);
    }

    // ── Step 4: Trigger Email Octopus cancellation email ──
    if (EMAILOCTOPUS_API_KEY && OCTOPUS_LIST_CANCELED && props.email) {
      try {
        const emailHash = require('crypto').createHash('md5').update(props.email.toLowerCase()).digest('hex');

        const fields = {
          FirstName: props.firstname || '',
          Plan: (props.billing_subscription_plan || '').replace(/_/g, '-'),
          Interval: props.billing_subscription_interval || '',
          AccessUntil: props.expiration_date || '',
        };

        // Add or update contact on list
        const addRes = await fetch(`https://emailoctopus.com/api/1.6/lists/${OCTOPUS_LIST_CANCELED}/contacts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: EMAILOCTOPUS_API_KEY,
            email_address: props.email,
            fields: fields,
            status: 'SUBSCRIBED',
          }),
        });
        const addData = await addRes.json();
        let memberId = addData.id;

        if (!memberId) {
          // Contact already exists — update fields
          const updRes = await fetch(`https://emailoctopus.com/api/1.6/lists/${OCTOPUS_LIST_CANCELED}/contacts/${emailHash}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              api_key: EMAILOCTOPUS_API_KEY,
              fields: fields,
              status: 'SUBSCRIBED',
            }),
          });
          const updData = await updRes.json();
          memberId = updData.id || emailHash;
        }

        if (OCTOPUS_AUTOMATION_CANCELED && memberId) {
          const autoRes = await fetch(`https://emailoctopus.com/api/1.6/automations/${OCTOPUS_AUTOMATION_CANCELED}/queue`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              api_key: EMAILOCTOPUS_API_KEY,
              list_member_id: memberId,
            }),
          });
          const autoData = await autoRes.json();
          console.log(`hubspot-cancel: cancellation email triggered for ${props.email}`, autoData);
        }
      } catch (err) {
        console.error(`hubspot-cancel: Email Octopus error:`, err.message);
      }
    }

    return res.status(200).json({ success: true, message: 'Subscription canceled' });

  } catch (err) {
    console.error('hubspot-cancel: unexpected error:', err);
    return res.status(200).json({ error: err.message }); // Always 200 to prevent HubSpot retry storms
  }
};
