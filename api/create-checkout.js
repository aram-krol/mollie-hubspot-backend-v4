// /api/create-checkout.js
// Disease Atlas — Direct Checkout Endpoint
//
// Receives form data from the pricing page, creates a HubSpot deal + contact,
// creates a Mollie payment, and returns the checkout URL for browser redirect.
//
// Design doc: wiki/architecture/direct-checkout-implementation.md
// HubSpot property map: wiki/architecture/hubspot-workflows.md

const { createMollieClient } = require('@mollie/api-client');
const hubspot = require('@hubspot/api-client');

const mollieClient = createMollieClient({ apiKey: process.env.MOLLIE_API_KEY });
const hubspotClient = new hubspot.Client({ accessToken: process.env.HUBSPOT_PRIVATE_APP_TOKEN });

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

// Server-side price table (source of truth — NEVER trust prices from frontend)
const PRICE_TABLE = {
  'academic-pro':  { monthly: { EUR: '135.00', USD: '150.00' }, annual: { EUR: '1200.00', USD: '1320.00' } },
  'academic-team': { monthly: { EUR: '270.00', USD: '300.00' }, annual: { EUR: '2400.00', USD: '2640.00' } },
  'professional':  { monthly: { EUR: '400.00', USD: '440.00' }, annual: { EUR: '3600.00', USD: '3960.00' } },
};

// EU standard VAT rates — updated 2026-04-10 (source: taxfoundation.org)
const EU_VAT_RATES = {
  NL: 21, DE: 19, FR: 20, BE: 21, AT: 20, IT: 22, ES: 21,
  PT: 23, IE: 23, FI: 25.5, SE: 25, DK: 25, PL: 23, CZ: 21,
  SK: 23, HU: 27, RO: 21, BG: 20, HR: 25, SI: 22, LT: 21,
  LV: 21, EE: 24, CY: 19, MT: 18, LU: 17, GR: 24,
};

const EU_COUNTRIES = Object.keys(EU_VAT_RATES);

// European countries that use EUR pricing (EU + non-EU European)
// Non-EU European countries get EUR pricing but 0% VAT (export)
const EUR_COUNTRIES = [
  ...EU_COUNTRIES,
  'GB', 'CH', 'NO', 'IS', 'LI',                          // UK, EFTA
  'AL', 'BA', 'ME', 'MK', 'RS', 'XK', 'MD', 'UA', 'BY', // Balkans + Eastern Europe
];

// CORS — only allow requests from the Euretos website
const ALLOWED_ORIGINS = [
  'https://www.euretos.com',
  'https://euretos.com',
  'https://ask.euretos.com',
];

// HubSpot SaaS Billing pipeline stage IDs
const STAGES = {
  AWAITING_PAYMENT: '3912561851',
  CLOSED_WON_ONETIME: '3912561853',
  CLOSED_WON_SUBSCRIPTION: '3912561854',
  LOST_PAYMENT_FAILED: '3912561855',
};

// Human-readable plan names for HubSpot deal properties
const PLAN_LABELS = {
  'academic-pro': 'Academic Pro',
  'academic-team': 'Academic Team',
  'professional': 'Professional',
};

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

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

  // Reject requests from unknown origins
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const { plan, interval, email, firstName, lastName, company, country, vatId } = req.body;

    // ── Input validation ──
    if (!plan || !interval || !email || !firstName || !country) {
      return res.status(400).json({ error: 'Missing required fields: plan, interval, email, firstName, country' });
    }
    if (!PRICE_TABLE[plan]) {
      return res.status(400).json({ error: `Invalid plan: ${plan}. Valid plans: ${Object.keys(PRICE_TABLE).join(', ')}` });
    }
    if (!['monthly', 'annual'].includes(interval)) {
      return res.status(400).json({ error: 'Invalid interval. Must be "monthly" or "annual".' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }
    if (!/^[A-Z]{2}$/i.test(country)) {
      return res.status(400).json({ error: 'Country must be a 2-letter ISO 3166-1 code (e.g. NL, DE, US)' });
    }

    // ── Currency determination (server-side, from country) ──
    const countryUpper = country.toUpperCase();
    const isEU = EU_COUNTRIES.includes(countryUpper);
    const isEurZone = EUR_COUNTRIES.includes(countryUpper);
    const currency = isEurZone ? 'EUR' : 'USD';

    // ── Server-side price lookup ──
    const priceExVat = parseFloat(PRICE_TABLE[plan][interval][currency]);

    // ── VAT calculation ──
    let vatTreatment = 'export';   // default for non-EU countries
    let vatRate = 0;
    let vatAmount = 0;

    if (isEU && vatId && vatId.trim()) {
      // EU B2B with VAT ID -> reverse charge (0% VAT)
      vatTreatment = 'reverse_charge';
      vatRate = 0;
      vatAmount = 0;
      // Fire-and-forget VIES validation — update deal later if invalid
      validateViesAsync(vatId.trim(), countryUpper).catch(err => {
        console.error('VIES validation failed (non-blocking):', err.message);
      });
    } else if (isEU) {
      // EU consumer -> standard VAT at country rate
      vatTreatment = 'standard';
      vatRate = EU_VAT_RATES[countryUpper] || 21;
      vatAmount = Math.round(priceExVat * vatRate) / 100;
    }
    // Non-EU (including non-EU European like UK, CH): export, 0% VAT

    const totalAmount = (priceExVat + vatAmount).toFixed(2);
    const paymentMode = (interval === 'monthly' || interval === 'annual') ? 'subscription' : 'one_time';

    // ── Step 1: Find or create HubSpot contact ──
    let contactId;
    try {
      const searchResult = await hubspotClient.crm.contacts.searchApi.doSearch({
        filterGroups: [{
          filters: [{ propertyName: 'email', operator: 'EQ', value: email.toLowerCase() }],
        }],
        limit: 1,
      });

      if (searchResult.results.length > 0) {
        contactId = searchResult.results[0].id;
        // Update contact with latest info (name, company may have changed)
        await hubspotClient.crm.contacts.basicApi.update(contactId, {
          properties: {
            firstname: firstName,
            lastname: lastName || '',
            company: company || '',
          },
        });
      } else {
        const newContact = await hubspotClient.crm.contacts.basicApi.create({
          properties: {
            email: email.toLowerCase(),
            firstname: firstName,
            lastname: lastName || '',
            company: company || '',
          },
        });
        contactId = newContact.id;
      }
    } catch (err) {
      console.error('HubSpot contact error:', err.message);
      return res.status(500).json({ error: 'Failed to process contact. Please try again.' });
    }

    // ── Step 1b: Idempotency check ──
    // If there's already a pending deal for this email + plan, return the existing checkout URL
    // instead of creating a duplicate
    try {
      const existingDeals = await hubspotClient.crm.deals.searchApi.doSearch({
        filterGroups: [{
          filters: [
            { propertyName: 'billing_plan', operator: 'EQ', value: PLAN_LABELS[plan] },
            { propertyName: 'payment_status', operator: 'EQ', value: 'pending' },
          ],
        }],
        properties: ['payment_link', 'billing_plan', 'payment_status', 'dealname'],
        limit: 10,
      });

      // Check if any pending deal is associated with this contact
      for (const deal of existingDeals.results) {
        if (deal.properties.payment_link) {
          // Verify this deal belongs to this contact by checking the deal name contains the email
          if (deal.properties.dealname && deal.properties.dealname.includes(email.toLowerCase())) {
            console.log(`Returning existing checkout for deal ${deal.id}`);
            return res.status(200).json({
              checkoutUrl: deal.properties.payment_link,
              dealId: deal.id,
              reused: true,
            });
          }
        }
      }
    } catch (err) {
      // Non-fatal: if idempotency check fails, just create a new deal
      console.error('Idempotency check failed (non-blocking):', err.message);
    }

    // ── Step 2: Create HubSpot deal ──
    let dealId;
    try {
      const deal = await hubspotClient.crm.deals.basicApi.create({
        properties: {
          dealname: `${PLAN_LABELS[plan]} ${interval} — ${email.toLowerCase()}`,
          pipeline: '2856169681',                         // SaaS Billing pipeline
          dealstage: STAGES.AWAITING_PAYMENT,
          billing_plan: PLAN_LABELS[plan],
          billing_interval: interval.charAt(0).toUpperCase() + interval.slice(1), // "Monthly" / "Annual"
          billing_country: countryUpper,
          billing_vat_id: vatId ? vatId.trim() : '',
          billing_vat_treatment: vatTreatment,
          vat_rate____: vatRate.toString(),
          billing_vat_amount: vatAmount.toFixed(2),
          billing_price_ex_vat: priceExVat.toFixed(2),
          billing_total_amount_incl_vat: totalAmount,
          billing_currency: currency === 'EUR' ? 'Euro €' : 'US $',
          payment_mode: paymentMode === 'subscription' ? 'subscription' : 'one_time',
          payment_status: 'pending',
        },
      });
      dealId = deal.id;

      // Associate deal with contact
      await hubspotClient.crm.deals.associationsApi.create(
        dealId,
        'contacts',
        contactId,
        [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }]
      );
    } catch (err) {
      console.error('HubSpot deal error:', err.message);
      return res.status(500).json({ error: 'Failed to create order. Please try again.' });
    }

    // ── Step 3: Create Mollie customer (needed for subscriptions) ──
    // Mollie requires a customerId to later create subscriptions.
    // We create a customer for every payment (even one-time) so the customer
    // is available if they later upgrade to a subscription.
    let mollieCustomerId;
    try {
      const mollieCustomer = await mollieClient.customers.create({
        name: `${firstName} ${lastName || ''}`.trim(),
        email: email.toLowerCase(),
        metadata: { hubspotContactId: contactId },
      });
      mollieCustomerId = mollieCustomer.id;
    } catch (err) {
      console.error('Mollie customer creation error:', err.message);
      // Non-fatal for one-time payments, fatal for subscriptions
      if (paymentMode === 'subscription') {
        await hubspotClient.crm.deals.basicApi.update(dealId, {
          properties: { payment_status: 'failed', dealstage: STAGES.LOST_PAYMENT_FAILED },
        }).catch(e => console.error('Failed to update deal:', e.message));
        return res.status(500).json({ error: 'Failed to set up payment. Please try again.' });
      }
    }

    // ── Step 4: Create Mollie payment ──
    let payment;
    try {
      const paymentParams = {
        amount: { currency, value: totalAmount },
        description: `Disease Atlas — ${PLAN_LABELS[plan]} (${interval})`,
        redirectUrl: `https://www.euretos.com/payment-complete?dealId=${dealId}`,
        webhookUrl: 'https://mollie-hubspot-backend-v4.vercel.app/api/mollie-webhook',
        metadata: {
          dealId,
          contactId,
          plan,
          interval,
          vatTreatment,
          currency,
          vatId: vatId ? vatId.trim() : '',
          country: countryUpper,
        },
      };

      // Attach customer so Mollie links the payment (and mandate) to them
      if (mollieCustomerId) {
        paymentParams.customerId = mollieCustomerId;
      }

      // For subscriptions: sequenceType 'first' creates a mandate for recurring charges
      if (paymentMode === 'subscription') {
        paymentParams.sequenceType = 'first';
      }

      payment = await mollieClient.payments.create(paymentParams);
    } catch (err) {
      console.error('Mollie payment error:', err.message);
      // Mark deal as failed
      await hubspotClient.crm.deals.basicApi.update(dealId, {
        properties: { payment_status: 'failed', dealstage: STAGES.LOST_PAYMENT_FAILED },
      }).catch(e => console.error('Failed to update deal after Mollie error:', e.message));
      return res.status(500).json({ error: 'Failed to create payment. Please try again.' });
    }

    // ── Step 5: Update deal with Mollie payment info ──
    const checkoutUrl = payment.getCheckoutUrl();
    try {
      await hubspotClient.crm.deals.basicApi.update(dealId, {
        properties: {
          payment_link: checkoutUrl,
          mollie_first_payment_id: payment.id,
          billing_payment_link_expires_at: payment.expiresAt || '',
        },
      });
    } catch (err) {
      // Non-fatal: payment is created, user can still check out
      console.error('HubSpot update error (non-fatal):', err.message);
    }

    // ── Return checkout URL to browser ──
    return res.status(200).json({
      checkoutUrl,
      dealId,
    });

  } catch (err) {
    console.error('Unexpected error in create-checkout:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// VIES VAT validation (async, non-blocking)
// ─────────────────────────────────────────────────────────────────────────────

async function validateViesAsync(vatId, countryCode) {
  // Strip country prefix if present (e.g. "NL123456789B01" -> "123456789B01")
  const vatNumber = vatId.startsWith(countryCode)
    ? vatId.substring(countryCode.length)
    : vatId;

  try {
    const response = await fetch(
      `https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          countryCode,
          vatNumber,
        }),
      }
    );

    if (!response.ok) {
      console.warn(`VIES API returned ${response.status} for ${countryCode}${vatNumber}`);
      return; // VIES is unreliable — don't block checkout
    }

    const result = await response.json();

    if (!result.valid) {
      console.warn(`VAT ID ${countryCode}${vatNumber} is INVALID per VIES`);
      // TODO: Update the HubSpot deal to flag the invalid VAT ID
      // For now, log it — the finance team can follow up manually
    }
  } catch (err) {
    // VIES is notoriously unreliable — swallow errors
    console.warn('VIES validation error (swallowed):', err.message);
  }
}
