export const GOYUNIR_STORE_SUITE = {
  // GLOBAL BRAND VISUAL COLOR PALETTE (Hex Codes)
  themeColors: {
    primaryBackground: '#0a0a0a',   // Dark cinematic main body canvas backdrop
    cardBackground: '#111111',      // Base tint frame for form boxes & conversion zones
    cardBorder: '#222222',          // Subtle dividing lines
    accentPurple: '#a855f7',        // Color footprint for White collection styling/alerts
    accentBlue: '#3b82f6',          // Color footprint for Black collection styling/alerts
    textMain: '#ffffff',            // Clear structural headings
    textMuted: '#888888',           // Description and fallback lines
    checkoutCtaButton: '#635bff',   // Premium Stripe blue-violet checkout trigger color
  },

  // 360 HARDWARE ROTATION MECHANICS CONTROL (Simple Math Adjustments)
  animationMechanics: {
    totalFramesToLoad: 4,           // Your front-snap visual loop frame count
    maxRotationDegrees: 360,        // The degree boundary constraints mapped on scroll progress
    spinReverseOnAlternatingProgress: true, // Forces bottle to unwind opposite way on alternative swipes
  },

  // STUPID-PROOF LIVE FORM MAKER ENGINE
  // Change labels, placeholder texts, or warning texts below without touching the code!
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
    instagramLink: 'https://instagram.com/goyunir',
    tiktokLink: 'https://tiktok.com',
    supportEmail: 'contact@goyunir.com',
    shippingReturnPolicyText: 'Shipping & Returns Policy Apply.',
    corporateEntityCopyright: 'GOYUNIR MAISON. ALL RIGHTS RESERVED.',
  },

  // 0-EXPERIENCE ENTERPRISE LOTTERY RELEASE CATALOG DATA MATRIX
  productCatalog: [
    {
      id: 'p1',
      name: 'Elysian White',
      prefix: 'EXAMPLEPICV1', // Points directly to public asset image naming files
      tagline: 'WHITE ALLOCATION / 01',
      desc: 'Clean, electric profile variant constructed with premium bergamot.',
      price50ml: 85,
      price100ml: 140,
      stripeId50ml: 'price_1TxGXQPIsR6ijfBZUKefFNOI',
      stripeId100ml: 'price_1Txn9YPIsR6ijfBZJZhSdHEr',
      maxRaffleAllocationLimit: 10, // Max bottles allowed for submission inside a single queue entry
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
      stripeId50ml: 'price_1TxnJ3PIsR6ijfBZUFXVhIfF',
      stripeId100ml: 'price_1TxnJpPIsR6ijfBZVvlrffeO',
      maxRaffleAllocationLimit: 5,
      notes: [
        { label: 'TOP PROFILE', name: 'Midnight Spice', text: 'A dark sensory introduction of clove and rare cardamom.' },
        { label: 'HEART PROFILE', name: 'Obsidian Amber', text: 'Midnight jasmine absolute bleeding into raw vetiver roots.' },
        { label: 'BASE PROFILE', name: 'Earthy Timber', text: 'A rich cedarwood base that deepens as the hours develop.' }
      ]
    }
  ]
};
