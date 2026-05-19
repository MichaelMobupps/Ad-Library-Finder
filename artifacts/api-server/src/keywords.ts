// Curated keyword sets per product type.
// Each keyword is searched independently per country in the Ad Library.
// Add/remove keywords here to tune coverage vs scrape time.
//
// Heuristic: pick keywords that appear in ad copy / advertiser names of the
// segment you're targeting. CTA verbs ("Download now") and category nouns
// ("slots", "puzzle") both work.

export const MOBILE_KEYWORDS = [
  'game',
  'play free',
  'puzzle',
  'slots',
  'casino',
  'install now',
  'download now',
  'free to play',
  'mobile game',
  'play now',
];

export const CPS_KEYWORDS = [
  'shop now',
  'sale',
  'buy now',
  'free shipping',
  'subscribe',
  'limited time',
  'discount',
  'deals',
  'order now',
  'sign up',
];

export function keywordsFor(productType: 'mobile' | 'cps'): string[] {
  return productType === 'mobile' ? MOBILE_KEYWORDS : CPS_KEYWORDS;
}
