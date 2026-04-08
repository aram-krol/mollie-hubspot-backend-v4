// ============================================================================
// Disease Atlas Checkout Widget  v2
// ============================================================================
// Loads on the HubSpot pricing page (/tesforpricing).
// Add ONE line to  Settings → Website → Pages → Header HTML:
//
//   <script src="https://mollie-hubspot-backend-v4.vercel.app/api/checkout-widget.js"></script>
//
// What it does:
//   1. Auto-intercepts the three paid-plan "Get" CTA buttons
//      (Academic Pro, Academic Team, Professional) using their
//      webInteractiveContentId values in the CTA URL
//   2. Opens a checkout modal with interval toggle + customer form
//   3. Calls the Vercel create-checkout API
//   4. Redirects to Mollie's hosted payment page
//
// Trial and Enterprise/Free buttons are left untouched.
// ============================================================================

(function () {
  'use strict';

  const CHECKOUT_API = 'https://mollie-hubspot-backend-v4.vercel.app/api/create-checkout';

  // ── Map HubSpot CTA webInteractiveContentId → plan ──
  // These IDs come from the pricing page's encrypted CTA links
  const CTA_MAP = {
    '303294447857': 'academic-pro',
    '303310463213': 'academic-team',
    '303989590263': 'professional',
  };
  // Trial (303294448830) and Enterprise/Free (191186156174) are NOT intercepted

  // ── European countries use EUR pricing, all others use USD ──
  const EUR_COUNTRIES = [
    'NL','DE','FR','BE','AT','IT','ES','PT','IE','FI','SE','DK','PL','CZ',
    'SK','HU','RO','BG','HR','SI','LT','LV','EE','CY','MT','LU','GR',
    'GB','CH','NO','IS','LI','AL','BA','ME','MK','RS','XK','MD','UA','BY',
  ];

  // EU member states only (for VAT ID field visibility)
  const EU_MEMBER_STATES = [
    'NL','DE','FR','BE','AT','IT','ES','PT','IE','FI','SE','DK','PL','CZ',
    'SK','HU','RO','BG','HR','SI','LT','LV','EE','CY','MT','LU','GR',
  ];

  // ── Display prices (cosmetic only — backend is the source of truth) ──
  const PLANS = {
    'academic-pro':  { label: 'Academic Pro',  monthly: { EUR: 135,  USD: 150  }, annual: { EUR: 1200, USD: 1320 } },
    'academic-team': { label: 'Academic Team', monthly: { EUR: 270,  USD: 300  }, annual: { EUR: 2400, USD: 2640 } },
    'professional':  { label: 'Professional',  monthly: { EUR: 400,  USD: 440  }, annual: { EUR: 3600, USD: 3960 } },
  };

  // ── Country list ──
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
  let selectedInterval = 'annual'; // default to annual (better deal)

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
    .da-modal .da-subtitle { margin: 0 0 16px; font-size: 15px; color: #666; }

    /* ── Interval toggle ── */
    .da-interval-toggle {
      display: flex; background: #f0f4ff; border-radius: 8px; padding: 4px; margin-bottom: 16px;
    }
    .da-interval-toggle button {
      flex: 1; padding: 10px 8px; border: none; border-radius: 6px; font-size: 14px;
      font-weight: 600; cursor: pointer; background: transparent; color: #666;
      transition: all 0.2s;
    }
    .da-interval-toggle button.active {
      background: #fff; color: #1a1a2e; box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .da-interval-toggle button:hover:not(.active) { color: #333; }
    .da-interval-badge {
      display: inline-block; background: #22c55e; color: #fff; font-size: 11px;
      font-weight: 700; padding: 1px 6px; border-radius: 10px; margin-left: 6px;
      vertical-align: middle;
    }

    /* ── Price display ── */
    .da-price-summary {
      background: #f0f4ff; border-radius: 8px; padding: 12px 16px; margin-bottom: 20px;
      font-size: 14px; color: #333;
    }
    .da-price-summary strong { font-size: 20px; color: #1a1a2e; }

    /* ── Form ── */
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

      <div class="da-interval-toggle" id="da-interval-toggle">
        <button type="button" data-interval="annual" class="active">
          Annual <span class="da-interval-badge">Save 25%</span>
        </button>
        <button type="button" data-interval="monthly">Monthly</button>
      </div>

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

  // ── Interval toggle handler ──
  document.getElementById('da-interval-toggle').addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-interval]');
    if (!btn) return;
    selectedInterval = btn.dataset.interval;
    this.querySelectorAll('button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    updatePriceSummary(countrySelect.value);
  });

  // ── Country change → show/hide VAT + update price ──
  countrySelect.addEventListener('change', function () {
    const code = this.value.toUpperCase();
    document.getElementById('da-vat-row').classList.toggle('visible', EU_MEMBER_STATES.includes(code));
    updatePriceSummary(code);
  });

  function updatePriceSummary(countryCode) {
    const curr = EUR_COUNTRIES.includes(countryCode?.toUpperCase()) ? 'EUR' : 'USD';
    const symbol = curr === 'EUR' ? '\u20AC' : '$';
    const plan = PLANS[selectedPlan];
    if (!plan) return;
    const price = plan[selectedInterval]?.[curr];
    if (!price) return;
    const period = selectedInterval === 'monthly' ? '/month' : '/year';
    document.getElementById('da-price-summary').innerHTML =
      '<strong>' + symbol + price.toLocaleString() + '</strong>' + period +
      ' \u2014 ' + plan.label +
      (curr === 'USD' ? '<br><small>Prices in USD for non-European countries</small>' : '');
  }

  // ── Open modal ──
  function openCheckout(planId, interval) {
    selectedPlan = planId;
    selectedInterval = interval || 'annual';
    const plan = PLANS[planId];
    if (!plan) { console.error('DiseaseAtlas: Unknown plan:', planId); return; }

    document.getElementById('da-plan-title').textContent = 'Get ' + plan.label;
    document.getElementById('da-plan-subtitle').textContent =
      'Choose your billing cycle and complete your details below.';

    // Set interval toggle state
    document.querySelectorAll('#da-interval-toggle button').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.interval === selectedInterval);
    });

    // Set initial price (default to EUR until country is selected)
    updatePriceSummary(countrySelect.value || 'NL');

    // Reset error / button state
    document.getElementById('da-error').classList.remove('visible');
    document.getElementById('da-submit').disabled = false;
    document.getElementById('da-submit').innerHTML = 'Proceed to payment';

    overlay.classList.add('active');
  }

  // ── Close modal ──
  document.getElementById('da-close').addEventListener('click', function () { overlay.classList.remove('active'); });
  overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.classList.remove('active'); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') overlay.classList.remove('active'); });

  // ── Form submit → Vercel API → Mollie redirect ──
  document.getElementById('da-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var errorEl = document.getElementById('da-error');
    var submitBtn = document.getElementById('da-submit');
    errorEl.classList.remove('visible');

    var email = document.getElementById('da-email').value.trim();
    var firstName = document.getElementById('da-firstname').value.trim();
    var lastName = document.getElementById('da-lastname').value.trim();
    var company = document.getElementById('da-company').value.trim();
    var country = document.getElementById('da-country').value;
    var vatId = document.getElementById('da-vatid').value.trim();

    if (!email || !firstName || !country) {
      errorEl.textContent = 'Please fill in all required fields.';
      errorEl.classList.add('visible');
      return;
    }

    // Show loading
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="da-spinner"></span>Redirecting to payment...';

    try {
      var response = await fetch(CHECKOUT_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan: selectedPlan,
          interval: selectedInterval,
          email: email,
          firstName: firstName,
          lastName: lastName,
          company: company,
          country: country,
          vatId: vatId,
        }),
      });

      var data = await response.json();

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
      console.error('DiseaseAtlas checkout error:', err);
    }
  });

  // ── Expose globally ──
  window.DiseaseAtlasCheckout = { open: openCheckout };

  // ══════════════════════════════════════════════════════════════════════════
  // AUTO-INTERCEPT HubSpot CTA buttons on the pricing page
  // ══════════════════════════════════════════════════════════════════════════
  // HubSpot CTA links contain webInteractiveContentId as a URL parameter.
  // We match paid-plan CTAs by their known IDs and replace the click handler.
  // Trial and Enterprise/Free CTAs are left untouched.
  // ══════════════════════════════════════════════════════════════════════════

  function interceptCTAs() {
    var intercepted = 0;

    // HubSpot CTAs render as <a> inside .hs-cta-wrapper, or as direct links
    // containing /hs/cta/ in the href. We check all links on the page.
    document.querySelectorAll('a[href]').forEach(function (link) {
      var href = link.getAttribute('href') || '';

      // Check if this is a HubSpot CTA link
      if (href.indexOf('/hs/cta/') === -1 && href.indexOf('hs/cta') === -1) return;

      // Extract webInteractiveContentId from the URL
      var match = href.match(/webInteractiveContentId=(\d+)/);
      if (!match) return;

      var ctaId = match[1];
      var planId = CTA_MAP[ctaId];
      if (!planId) return; // Not a paid plan CTA — leave it alone

      // Replace the link behavior
      link.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openCheckout(planId, 'annual');
      }, true); // useCapture to beat HubSpot's own handlers

      // Also block the href navigation as a fallback
      link.setAttribute('href', 'javascript:void(0)');

      intercepted++;
    });

    return intercepted;
  }

  // HubSpot CTA buttons load asynchronously (they're injected by hs-cta JS).
  // We poll briefly until we find them, then stop.
  var attempts = 0;
  var maxAttempts = 40; // 40 × 500ms = 20 seconds max wait
  var pollTimer = setInterval(function () {
    attempts++;
    var found = interceptCTAs();
    if (found > 0 || attempts >= maxAttempts) {
      clearInterval(pollTimer);
      if (found > 0) {
        console.log('DiseaseAtlas: Intercepted ' + found + ' paid-plan CTA button(s)');
      } else {
        console.warn('DiseaseAtlas: No paid-plan CTA buttons found after ' + maxAttempts + ' attempts');
      }
    }
  }, 500);

})();
