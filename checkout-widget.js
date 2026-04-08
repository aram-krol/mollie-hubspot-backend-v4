// ============================================================================
// Disease Atlas Checkout Widget
// ============================================================================
// Add this script to the HubSpot pricing page via:
//   Settings → Advanced → Header HTML
//   or as a custom HubSpot module
//
// This script:
//   1. Intercepts "Get" button clicks on pricing cards
//   2. Shows a checkout modal collecting customer details
//   3. Updates displayed prices based on selected country (EUR/USD)
//   4. Calls the Vercel backend to create a Mollie checkout
//   5. Redirects the user to Mollie's payment page
// ============================================================================

(function () {
  'use strict';

  const CHECKOUT_API = 'https://mollie-hubspot-backend-v4.vercel.app/api/create-checkout';

  // ── European countries use EUR pricing, all others use USD ──
  // Must match the backend's EUR_COUNTRIES list exactly
  const EUR_COUNTRIES = [
    'NL','DE','FR','BE','AT','IT','ES','PT','IE','FI','SE','DK','PL','CZ',
    'SK','HU','RO','BG','HR','SI','LT','LV','EE','CY','MT','LU','GR',
    'GB','CH','NO','IS','LI','AL','BA','ME','MK','RS','XK','MD','UA','BY',
  ];

  // ── Display prices (cosmetic only — backend is source of truth) ──
  const PLANS = {
    'academic-pro':  { label: 'Academic Pro',  monthly: { EUR: 135,  USD: 150  }, annual: { EUR: 1200, USD: 1320 } },
    'academic-team': { label: 'Academic Team', monthly: { EUR: 270,  USD: 300  }, annual: { EUR: 2400, USD: 2640 } },
    'professional':  { label: 'Professional',  monthly: { EUR: 400,  USD: 440  }, annual: { EUR: 3600, USD: 3960 } },
  };

  // ── Country list for the dropdown ──
  const COUNTRIES = [
    {code:'AF',name:'Afghanistan'},{code:'AL',name:'Albania'},{code:'DZ',name:'Algeria'},{code:'AR',name:'Argentina'},
    {code:'AT',name:'Austria'},{code:'AU',name:'Australia'},{code:'BE',name:'Belgium'},{code:'BG',name:'Bulgaria'},
    {code:'BR',name:'Brazil'},{code:'BY',name:'Belarus'},{code:'CA',name:'Canada'},{code:'CH',name:'Switzerland'},
    {code:'CN',name:'China'},{code:'CY',name:'Cyprus'},{code:'CZ',name:'Czech Republic'},{code:'DE',name:'Germany'},
    {code:'DK',name:'Denmark'},{code:'EE',name:'Estonia'},{code:'EG',name:'Egypt'},{code:'ES',name:'Spain'},
    {code:'FI',name:'Finland'},{code:'FR',name:'France'},{code:'GB',name:'United Kingdom'},{code:'GR',name:'Greece'},
    {code:'HR',name:'Croatia'},{code:'HU',name:'Hungary'},{code:'ID',name:'Indonesia'},{code:'IE',name:'Ireland'},
    {code:'IL',name:'Israel'},{code:'IN',name:'India'},{code:'IS',name:'Iceland'},{code:'IT',name:'Italy'},
    {code:'JP',name:'Japan'},{code:'KR',name:'South Korea'},{code:'LI',name:'Liechtenstein'},{code:'LT',name:'Lithuania'},
    {code:'LU',name:'Luxembourg'},{code:'LV',name:'Latvia'},{code:'ME',name:'Montenegro'},{code:'MK',name:'North Macedonia'},
    {code:'MT',name:'Malta'},{code:'MX',name:'Mexico'},{code:'MY',name:'Malaysia'},{code:'NL',name:'Netherlands'},
    {code:'NO',name:'Norway'},{code:'NZ',name:'New Zealand'},{code:'PH',name:'Philippines'},{code:'PL',name:'Poland'},
    {code:'PT',name:'Portugal'},{code:'RO',name:'Romania'},{code:'RS',name:'Serbia'},{code:'RU',name:'Russia'},
    {code:'SA',name:'Saudi Arabia'},{code:'SE',name:'Sweden'},{code:'SG',name:'Singapore'},{code:'SI',name:'Slovenia'},
    {code:'SK',name:'Slovakia'},{code:'TH',name:'Thailand'},{code:'TR',name:'Turkey'},{code:'TW',name:'Taiwan'},
    {code:'UA',name:'Ukraine'},{code:'US',name:'United States'},{code:'ZA',name:'South Africa'},
  ];

  // ── State ──
  let selectedPlan = null;
  let selectedInterval = null;

  // ── Inject CSS ──
  const style = document.createElement('style');
  style.textContent = `
    .da-overlay {
      display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.5); z-index: 10000; justify-content: center; align-items: center;
    }
    .da-overlay.active { display: flex; }
    .da-modal {
      background: #fff; border-radius: 12px; padding: 32px; max-width: 480px; width: 90%;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3); font-family: 'Inter', -apple-system, sans-serif;
      max-height: 90vh; overflow-y: auto; position: relative;
    }
    .da-modal h2 { margin: 0 0 4px; font-size: 22px; color: #1a1a2e; }
    .da-modal .da-subtitle { margin: 0 0 20px; font-size: 15px; color: #666; }
    .da-modal .da-price-summary {
      background: #f0f4ff; border-radius: 8px; padding: 12px 16px; margin-bottom: 20px;
      font-size: 14px; color: #333;
    }
    .da-modal .da-price-summary strong { font-size: 20px; color: #1a1a2e; }
    .da-modal label { display: block; font-size: 13px; font-weight: 600; color: #444; margin-bottom: 4px; }
    .da-modal input, .da-modal select {
      width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 6px;
      font-size: 14px; margin-bottom: 14px; box-sizing: border-box;
      transition: border-color 0.2s;
    }
    .da-modal input:focus, .da-modal select:focus { outline: none; border-color: #4a6cf7; }
    .da-modal .da-row { display: flex; gap: 12px; }
    .da-modal .da-row > div { flex: 1; }
    .da-modal .da-vat-row { display: none; }
    .da-modal .da-vat-row.visible { display: block; }
    .da-btn-checkout {
      width: 100%; padding: 14px; background: #4a6cf7; color: #fff; border: none;
      border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer;
      transition: background 0.2s;
    }
    .da-btn-checkout:hover { background: #3a5ce5; }
    .da-btn-checkout:disabled { background: #aaa; cursor: not-allowed; }
    .da-btn-close {
      position: absolute; top: 12px; right: 16px; background: none; border: none;
      font-size: 24px; color: #999; cursor: pointer; line-height: 1;
    }
    .da-btn-close:hover { color: #333; }
    .da-error { background: #fef2f2; color: #991b1b; padding: 10px 14px; border-radius: 6px; font-size: 13px; margin-bottom: 14px; display: none; }
    .da-error.visible { display: block; }
    .da-terms { font-size: 12px; color: #888; margin-top: 12px; text-align: center; }
    .da-terms a { color: #4a6cf7; }
    .da-spinner { display: inline-block; width: 18px; height: 18px; border: 2px solid #fff; border-top-color: transparent; border-radius: 50%; animation: da-spin 0.6s linear infinite; vertical-align: middle; margin-right: 8px; }
    @keyframes da-spin { to { transform: rotate(360deg); } }
  `;
  document.head.appendChild(style);

  // ── Build modal HTML ──
  const overlay = document.createElement('div');
  overlay.className = 'da-overlay';
  overlay.innerHTML = `
    <div class="da-modal">
      <button class="da-btn-close" id="da-close">&times;</button>
      <h2 id="da-plan-title">Subscribe</h2>
      <p class="da-subtitle" id="da-plan-subtitle"></p>
      <div class="da-price-summary" id="da-price-summary"></div>
      <div class="da-error" id="da-error"></div>
      <form id="da-form" autocomplete="on">
        <div class="da-row">
          <div>
            <label for="da-firstname">First name *</label>
            <input type="text" id="da-firstname" name="firstname" required autocomplete="given-name">
          </div>
          <div>
            <label for="da-lastname">Last name</label>
            <input type="text" id="da-lastname" name="lastname" autocomplete="family-name">
          </div>
        </div>
        <label for="da-email">Work email *</label>
        <input type="email" id="da-email" name="email" required autocomplete="email">
        <label for="da-company">Organization</label>
        <input type="text" id="da-company" name="company" autocomplete="organization">
        <label for="da-country">Country *</label>
        <select id="da-country" name="country" required>
          <option value="">Select your country...</option>
        </select>
        <div class="da-vat-row" id="da-vat-row">
          <label for="da-vatid">EU VAT ID (optional, for reverse charge)</label>
          <input type="text" id="da-vatid" name="vat_id" placeholder="e.g. NL123456789B01" autocomplete="off">
        </div>
        <button type="submit" class="da-btn-checkout" id="da-submit">
          Proceed to payment
        </button>
      </form>
      <p class="da-terms">
        By proceeding you agree to our <a href="/terms" target="_blank">Terms of Service</a>.
        Payments are processed securely by Mollie.
      </p>
    </div>
  `;
  document.body.appendChild(overlay);

  // ── Populate country dropdown ──
  const countrySelect = document.getElementById('da-country');
  COUNTRIES.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.code;
    opt.textContent = c.name;
    countrySelect.appendChild(opt);
  });

  // ── Country change handler: show/hide VAT field + update price display ──
  countrySelect.addEventListener('change', function () {
    const code = this.value.toUpperCase();
    const EU = Object.keys({
      NL:1,DE:1,FR:1,BE:1,AT:1,IT:1,ES:1,PT:1,IE:1,FI:1,SE:1,DK:1,PL:1,CZ:1,
      SK:1,HU:1,RO:1,BG:1,HR:1,SI:1,LT:1,LV:1,EE:1,CY:1,MT:1,LU:1,GR:1,
    });
    const isEU = EU.includes(code);
    document.getElementById('da-vat-row').classList.toggle('visible', isEU);

    // Update price display
    if (selectedPlan && selectedInterval) {
      updatePriceSummary(code);
    }

    // Update prices on the main page too
    updatePagePrices(code);
  });

  function updatePriceSummary(countryCode) {
    const curr = EUR_COUNTRIES.includes(countryCode?.toUpperCase()) ? 'EUR' : 'USD';
    const symbol = curr === 'EUR' ? '€' : '$';
    const plan = PLANS[selectedPlan];
    if (!plan) return;
    const price = plan[selectedInterval]?.[curr];
    if (!price) return;
    const period = selectedInterval === 'monthly' ? '/month' : '/year';
    document.getElementById('da-price-summary').innerHTML =
      `<strong>${symbol}${price.toLocaleString()}</strong>${period} &mdash; ${plan.label} (${selectedInterval})` +
      (curr === 'USD' ? '<br><small>Prices in USD for non-European countries</small>' : '');
  }

  // ── Update prices on the main pricing page (if using data attributes) ──
  function updatePagePrices(countryCode) {
    const curr = EUR_COUNTRIES.includes(countryCode?.toUpperCase()) ? 'EUR' : 'USD';
    const symbol = curr === 'EUR' ? '€' : '$';
    document.querySelectorAll('[data-plan][data-interval]').forEach(el => {
      const plan = el.dataset.plan;
      const interval = el.dataset.interval;
      if (PLANS[plan]?.[interval]?.[curr]) {
        el.textContent = `${symbol}${PLANS[plan][interval][curr].toLocaleString()}`;
      }
    });
  }

  // ── Open modal ──
  function openCheckout(planId, interval) {
    selectedPlan = planId;
    selectedInterval = interval;
    const plan = PLANS[planId];
    if (!plan) { console.error('Unknown plan:', planId); return; }

    document.getElementById('da-plan-title').textContent = `Get ${plan.label}`;
    document.getElementById('da-plan-subtitle').textContent =
      `${interval.charAt(0).toUpperCase() + interval.slice(1)} subscription`;

    // Set initial price (EUR default)
    const country = countrySelect.value;
    updatePriceSummary(country || 'NL');

    // Reset state
    document.getElementById('da-error').classList.remove('visible');
    document.getElementById('da-submit').disabled = false;
    document.getElementById('da-submit').innerHTML = 'Proceed to payment';

    overlay.classList.add('active');
  }

  // ── Close modal ──
  document.getElementById('da-close').addEventListener('click', () => overlay.classList.remove('active'));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('active'); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') overlay.classList.remove('active'); });

  // ── Form submit → call Vercel API → redirect to Mollie ──
  document.getElementById('da-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    const errorEl = document.getElementById('da-error');
    const submitBtn = document.getElementById('da-submit');
    errorEl.classList.remove('visible');

    const email = document.getElementById('da-email').value.trim();
    const firstName = document.getElementById('da-firstname').value.trim();
    const lastName = document.getElementById('da-lastname').value.trim();
    const company = document.getElementById('da-company').value.trim();
    const country = document.getElementById('da-country').value;
    const vatId = document.getElementById('da-vatid').value.trim();

    if (!email || !firstName || !country) {
      errorEl.textContent = 'Please fill in all required fields.';
      errorEl.classList.add('visible');
      return;
    }

    // Show loading
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="da-spinner"></span>Redirecting to payment...';

    try {
      const response = await fetch(CHECKOUT_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan: selectedPlan,
          interval: selectedInterval,
          email,
          firstName,
          lastName,
          company,
          country,
          vatId,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Something went wrong. Please try again.');
      }

      // Redirect to Mollie checkout
      window.location.href = data.checkoutUrl;

    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = 'Proceed to payment';
      errorEl.textContent = err.message || 'Something went wrong. Please try again or contact support.';
      errorEl.classList.add('visible');
      console.error('Checkout error:', err);
    }
  });

  // ── Expose globally so buttons can call it ──
  window.DiseaseAtlasCheckout = { open: openCheckout };

  // ══════════════════════════════════════════════════════════════════════════
  // INTEGRATION INSTRUCTIONS
  // ══════════════════════════════════════════════════════════════════════════
  //
  // OPTION A: Replace the existing HubSpot CTA buttons
  //   Find each "Get" button and change the onclick/href to:
  //
  //   <a href="javascript:void(0)" onclick="DiseaseAtlasCheckout.open('academic-pro', 'annual')">Get Academic Pro (Annual)</a>
  //   <a href="javascript:void(0)" onclick="DiseaseAtlasCheckout.open('academic-pro', 'monthly')">Get Academic Pro (Monthly)</a>
  //   <a href="javascript:void(0)" onclick="DiseaseAtlasCheckout.open('academic-team', 'annual')">Get Academic Team (Annual)</a>
  //   <a href="javascript:void(0)" onclick="DiseaseAtlasCheckout.open('academic-team', 'monthly')">Get Academic Team (Monthly)</a>
  //   <a href="javascript:void(0)" onclick="DiseaseAtlasCheckout.open('professional', 'annual')">Get Professional (Annual)</a>
  //   <a href="javascript:void(0)" onclick="DiseaseAtlasCheckout.open('professional', 'monthly')">Get Professional (Monthly)</a>
  //
  // OPTION B: Auto-intercept existing CTA buttons (if you can't edit them)
  //   Uncomment the block below. It finds all HubSpot CTA links on the page
  //   and replaces them based on their text content.
  //
  // ══════════════════════════════════════════════════════════════════════════

  /*
  // Auto-intercept HubSpot CTA buttons
  document.addEventListener('DOMContentLoaded', function() {
    // Map button text patterns to plan+interval
    const buttonMap = [
      { match: /academic\s*pro.*annual/i, plan: 'academic-pro', interval: 'annual' },
      { match: /academic\s*pro.*month/i,  plan: 'academic-pro', interval: 'monthly' },
      { match: /academic\s*team.*annual/i, plan: 'academic-team', interval: 'annual' },
      { match: /academic\s*team.*month/i,  plan: 'academic-team', interval: 'monthly' },
      { match: /professional.*annual/i,    plan: 'professional', interval: 'annual' },
      { match: /professional.*month/i,     plan: 'professional', interval: 'monthly' },
    ];

    document.querySelectorAll('a[href*="hs/cta"], .hs-cta-wrapper a').forEach(link => {
      const text = link.textContent.trim();
      for (const mapping of buttonMap) {
        if (mapping.match.test(text)) {
          link.href = 'javascript:void(0)';
          link.onclick = function(e) {
            e.preventDefault();
            DiseaseAtlasCheckout.open(mapping.plan, mapping.interval);
          };
          break;
        }
      }
    });
  });
  */

})();
