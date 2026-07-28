export const GOYUNIR_STORE_SUITE = {
  // GLOBAL BRAND VISUAL COLOR PALETTE (Hex Codes)
  themeColors: {
    primaryBackground: '#0a0a0a',   // Dark main body backdrop
    cardBackground: '#111111',      // Base tint frame for form boxes
    cardBorder: '#222222',          // Subtle dividing lines
    accentPurple: '#a855f7',        // White collection styling accent
    accentBlue: '#3b82f6',          // Black collection styling accent
    textMain: '#ffffff',            // Clear structural headings
    textMuted: '#888888',           // Description and fallback lines
    checkoutCtaButton: '#635bff',   // Stripe checkout trigger color
  },

  // STUPID-PROOF AUTOMATED DROP SCHEDULE CONTROL MATRIX
  // Simply change the text parameters below to shift deadlines without code editing!
  dropSchedule: {
    // Standard ISO string format: YYYY-MM-DDTHH:MM:SS (e.g. July 31st, 2026 at Midnight)
    targetEndDateTime: '2026-07-31T23:59:59', 
    countdownExpiredText: 'ALLOCATION CLOSED • VARIANT ARCHIVED',
    daysLabel: 'd',
    hoursLabel: 'h',
    minutesLabel: 'm',
    secondsLabel: 's',
  },

  // 360 HARDWARE ROTATION MECHANICS CONTROL
  animationMechanics: {
    totalFramesToLoad: 4,           
    maxRotationDegrees: 360,        
    spinReverseOnAlternatingProgress: true, 
  },

  // STUPID-PROOF LIVE FORM MAKER ENGINE
  raffleRegistrationForm: {
    titleHeader: 'Join The Allocation Draw',
    emailLabel: 'Contact Email Address',
    emailPlaceholder: 'name@domain.com',
    addressLabel: 'Full Shipping Destination',
    addressPlaceholder: '123 Luxury Dr, New York, NY',
    submitButtonText: '🏆 Secure Entry Allocation Ticket',
    submitButtonLoadingText: 'Encrypting Entry Base...',
  },

  // COLD SOCIAL MEDIA & CORPORATE FOOTER PANEL METRICS
  brandFooterData: {
    instagramLink: 'https://instagram.com',
    tiktokLink: 'https://tiktok.com',
    supportEmail: 'contact@goyunir.com',
    shippingReturnPolicyText: 'Shipping & Returns Policy Apply.',
    corporateEntityCopyright: 'GOYUNIR MAISON. ALL RIGHTS RESERVED.',
  },

  // ENTERPRISE PRODUCT CATALOG MATRIX
  productCatalog: [
    {
      id: 'p1',
      name: 'Elysian White',
      prefix: 'EXAMPLEPICV1', 
      tagline: 'WHITE ALLOCATION / 01',
      desc: 'Clean, electric profile variant constructed with premium bergamot.',
      price50ml: 85,
      price100ml: 140,
      stripeId50ml: 'price_1N_ElysianWhite_50ml_LIVE_TOKEN_A',
      stripeId100ml: 'price_1N_ElysianWhite_100ml_LIVE_TOKEN_B',
      maxRaffleAllocationLimit: 10, 
      notes: [
        { label: 'TOP PROFILE', name: 'White Bergamot', text: 'Crisp Sicilian bergamot crushed with volcanic pink pepper.' },
        { label: 'HEART PROFILE', name: 'Citrus Flash', text: 'Fresh, electric burst optimized to capture immediate attention.' },
        { label: 'BASE PROFILE', name: 'Clean Musk', text: 'A smooth velvet finish that lingers delicately on fabrics.' }
      ]
    },
    {
      id: 'p2',
      name: 'Obsidian Void',
      prefix: 'EXAMPLEPICV2',
      tagline: 'BLACK ALLOCATION / 02',
      desc: 'Deep, smoke-infused wood profile variant designed for lasting depth.',
      price50ml: 85,
      price100ml: 140,
      stripeId50ml: 'price_1N_ObsidianVoid_50ml_LIVE_TOKEN_C',
      stripeId100ml: 'price_1N_ObsidianVoid_100ml_LIVE_TOKEN_D',
      maxRaffleAllocationLimit: 5,
      notes: [
        { label: 'TOP PROFILE', name: 'Midnight Spice', text: 'A dark sensory introduction of clove and rare cardamom.' },
        { label: 'HEART PROFILE', name: 'Obsidian Amber', text: 'Midnight jasmine absolute bleeding into raw vetiver roots.' },
        { label: 'BASE PROFILE', name: 'Earthy Timber', text: 'A rich cedarwood base that deepens as the hours develop.' }
      ]
    }
  ]
};
