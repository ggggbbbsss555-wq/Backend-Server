// Plan catalog service. Mirrors quantvexa/plans page exactly:
//   Basic $50, Pro $75, Elite $100
// Prices are LOCKED — admin can edit features but never the price tier.

import config from '../config/env.js';

const PLANS = [
  {
    id: 'basic',
    name: 'Basic',
    price: config.plans.basic,
    currency: 'USD',
    duration: 'month',
    featured: false,
    tagline: 'For new traders getting started',
    features: [
      'Up to 100 signals per month',
      'Strong strategy access',
      'Telegram bot integration',
      'Basic trade history (30 days)',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: config.plans.pro,
    currency: 'USD',
    duration: 'month',
    featured: true,
    tagline: 'For serious active traders',
    features: [
      'Up to 500 signals per month',
      'All strategies (Strong, Medium, Pro)',
      'Advanced analytics dashboard',
      'Full trade history (unlimited)',
      'Priority 24/7 support',
      'Multi-exchange support',
    ],
  },
  {
    id: 'elite',
    name: 'Elite',
    price: config.plans.elite,
    currency: 'USD',
    duration: 'month',
    featured: false,
    tagline: 'For professional institutions',
    features: [
      'Unlimited signals',
      'All strategies + early access',
      'White-label dashboard',
      'Dedicated account manager',
      '24/7 phone support',
      'Custom integrations',
      'SLA guarantee',
    ],
  },
];

export const plansService = {
  list() { return PLANS; },
  get(id) { return PLANS.find(p => p.id === id) || null; },
  // Map a plan id to its locked price (used by the subscriptions service)
  priceFor(id) {
    const p = this.get(id);
    return p ? p.price : null;
  },
};

export default plansService;
