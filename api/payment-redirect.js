// /api/payment-redirect.js
// Disease Atlas — Mollie post-checkout redirect router
//
// Mollie's API only accepts a single redirectUrl. The user is sent there
// after a successful payment AND after clicking "Previous page" on the
// Mollie checkout — Mollie does not differentiate. This endpoint sits in
// front of the HubSpot pages, looks up the live Mollie payment status via
// the HubSpot deal, and 302s the user to the appropriate HubSpot page:
//
//   paid / authorized            -> /payment-complete (success page)
//   open / pending               -> /payment-complete (webhook will reconcile)
//   canceled / expired / failed  -> /payment-expired  (try again page)
//   unknown (no payment created) -> /payment-expired  (safer default)
//
// The Mollie `redirectUrl` set in /api/create-checkout.js points here.
// Created 2026-06-01 to close the false-success bug caught during the
// live-mode smoke test.
//
// Design doc: wiki/architecture/direct-checkout-implementation.md
//             §"Payment Complete page (/payment-complete)"

const { createMollieClient } = require('@mollie/api-client');
const hubspot = require('@hubspot/api-client');

const mollieClient = createMollieClient({ apiKey: process.env.MOLLIE_API_KEY });
const hubspotClient = new hubspot.Client({ accessToken: process.env.HUBSPOT_PRIVATE_APP_TOKEN });

const SUCCESS_URL = 'https://www.euretos.com/payment-complete';
const EXPIRED_URL = 'https://www.euretos.com/payment-expired';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { dealId } = req.query;
  const dealIdStr = dealId ? String(dealId) : '';
  const dealIdParam = dealIdStr ? '?dealId=' + encodeURIComponent(dealIdStr) : '';

  // No dealId on the URL — treat as expired.
  if (!dealIdStr || !/^\d+$/.test(dealIdStr)) {
    console.warn('payment-redirect: missing or invalid dealId', { dealId });
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(302, { Location: EXPIRED_URL });
    return res.end();
  }

  try {
    // ── Look up the deal in HubSpot to get the Mollie payment id ──
    let deal;
    try {
      deal = await hubspotClient.crm.deals.basicApi.getById(
        dealIdStr,
        ['mollie_first_payment_id'],
      );
    } catch (err) {
      if (err && err.code === 404) {
        console.warn(`payment-redirect: deal ${dealIdStr} not found`);
        res.setHeader('Cache-Control', 'no-store');
        res.writeHead(302, { Location: EXPIRED_URL + dealIdParam });
        return res.end();
      }
      throw err;
    }

    const paymentId = deal && deal.properties && deal.properties.mollie_first_payment_id;
    if (!paymentId) {
      console.warn(`payment-redirect: deal ${dealIdStr} has no mollie_first_payment_id`);
      res.setHeader('Cache-Control', 'no-store');
      res.writeHead(302, { Location: EXPIRED_URL + dealIdParam });
      return res.end();
    }

    // ── Query Mollie for the live status ──
    const payment = await mollieClient.payments.get(paymentId);
    console.log(`payment-redirect: dealId=${dealIdStr} paymentId=${payment.id} status=${payment.status}`);

    res.setHeader('Cache-Control', 'no-store');

    // paid / authorized / open / pending -> success page.
    // The webhook will reconcile open/pending into paid; WF1 emails the
    // user on confirmation. Showing the success page is the same UX we
    // have today and is correct for these states.
    if (
      payment.status === 'paid' ||
      payment.status === 'authorized' ||
      payment.status === 'open' ||
      payment.status === 'pending'
    ) {
      res.writeHead(302, { Location: SUCCESS_URL + dealIdParam });
      return res.end();
    }

    // canceled / expired / failed -> expired page.
    res.writeHead(302, { Location: EXPIRED_URL + dealIdParam });
    return res.end();
  } catch (err) {
    console.error('payment-redirect error:', { dealId: dealIdStr, message: err && err.message });
    // On any unexpected error, fall through to the expired page rather than
    // falsely claiming success. WF1 will still fire from the webhook if the
    // payment actually succeeded; the user will get the confirmation email.
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(302, { Location: EXPIRED_URL + dealIdParam });
    return res.end();
  }
};
