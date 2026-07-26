/**
 * Country catalog for the unified Google Ads form — all global geos except the
 * obviously irrelevant/embargoed (North Korea, Iran, Syria, Cuba, Antarctica,
 * uninhabited territories). MUST stay a superset of the api-server's
 * ALL_MARKETS (storeDiscoveryConfig.ts): the Mobile path intersects this list
 * with the server's market universe at render time, so a code the server
 * doesn't know is simply not offered for Mobile.
 *
 * Codes are UPPER-CASE ISO-3166 alpha-2 (the job API's `countries` format);
 * the Mobile submit path lower-cases them into store markets.
 */

export interface Country {
  code: string;
  name: string;
  region: string;
}

export const REGIONS = ['Americas', 'Europe', 'Middle East', 'Africa', 'Asia', 'Oceania'] as const;

export const COUNTRIES: Country[] = [
  // ── Americas ──
  { code: 'US', name: 'United States', region: 'Americas' },
  { code: 'CA', name: 'Canada', region: 'Americas' },
  { code: 'MX', name: 'Mexico', region: 'Americas' },
  { code: 'GT', name: 'Guatemala', region: 'Americas' },
  { code: 'BZ', name: 'Belize', region: 'Americas' },
  { code: 'HN', name: 'Honduras', region: 'Americas' },
  { code: 'SV', name: 'El Salvador', region: 'Americas' },
  { code: 'NI', name: 'Nicaragua', region: 'Americas' },
  { code: 'CR', name: 'Costa Rica', region: 'Americas' },
  { code: 'PA', name: 'Panama', region: 'Americas' },
  { code: 'DO', name: 'Dominican Republic', region: 'Americas' },
  { code: 'HT', name: 'Haiti', region: 'Americas' },
  { code: 'JM', name: 'Jamaica', region: 'Americas' },
  { code: 'TT', name: 'Trinidad & Tobago', region: 'Americas' },
  { code: 'BS', name: 'Bahamas', region: 'Americas' },
  { code: 'BB', name: 'Barbados', region: 'Americas' },
  { code: 'AR', name: 'Argentina', region: 'Americas' },
  { code: 'BO', name: 'Bolivia', region: 'Americas' },
  { code: 'BR', name: 'Brazil', region: 'Americas' },
  { code: 'CL', name: 'Chile', region: 'Americas' },
  { code: 'CO', name: 'Colombia', region: 'Americas' },
  { code: 'EC', name: 'Ecuador', region: 'Americas' },
  { code: 'GY', name: 'Guyana', region: 'Americas' },
  { code: 'PY', name: 'Paraguay', region: 'Americas' },
  { code: 'PE', name: 'Peru', region: 'Americas' },
  { code: 'SR', name: 'Suriname', region: 'Americas' },
  { code: 'UY', name: 'Uruguay', region: 'Americas' },
  { code: 'VE', name: 'Venezuela', region: 'Americas' },
  // ── Europe ──
  { code: 'GB', name: 'United Kingdom', region: 'Europe' },
  { code: 'IE', name: 'Ireland', region: 'Europe' },
  { code: 'FR', name: 'France', region: 'Europe' },
  { code: 'DE', name: 'Germany', region: 'Europe' },
  { code: 'AT', name: 'Austria', region: 'Europe' },
  { code: 'CH', name: 'Switzerland', region: 'Europe' },
  { code: 'BE', name: 'Belgium', region: 'Europe' },
  { code: 'NL', name: 'Netherlands', region: 'Europe' },
  { code: 'LU', name: 'Luxembourg', region: 'Europe' },
  { code: 'ES', name: 'Spain', region: 'Europe' },
  { code: 'PT', name: 'Portugal', region: 'Europe' },
  { code: 'IT', name: 'Italy', region: 'Europe' },
  { code: 'MT', name: 'Malta', region: 'Europe' },
  { code: 'GR', name: 'Greece', region: 'Europe' },
  { code: 'CY', name: 'Cyprus', region: 'Europe' },
  { code: 'DK', name: 'Denmark', region: 'Europe' },
  { code: 'SE', name: 'Sweden', region: 'Europe' },
  { code: 'NO', name: 'Norway', region: 'Europe' },
  { code: 'FI', name: 'Finland', region: 'Europe' },
  { code: 'IS', name: 'Iceland', region: 'Europe' },
  { code: 'EE', name: 'Estonia', region: 'Europe' },
  { code: 'LV', name: 'Latvia', region: 'Europe' },
  { code: 'LT', name: 'Lithuania', region: 'Europe' },
  { code: 'PL', name: 'Poland', region: 'Europe' },
  { code: 'CZ', name: 'Czechia', region: 'Europe' },
  { code: 'SK', name: 'Slovakia', region: 'Europe' },
  { code: 'HU', name: 'Hungary', region: 'Europe' },
  { code: 'SI', name: 'Slovenia', region: 'Europe' },
  { code: 'HR', name: 'Croatia', region: 'Europe' },
  { code: 'BA', name: 'Bosnia & Herzegovina', region: 'Europe' },
  { code: 'RS', name: 'Serbia', region: 'Europe' },
  { code: 'ME', name: 'Montenegro', region: 'Europe' },
  { code: 'MK', name: 'North Macedonia', region: 'Europe' },
  { code: 'AL', name: 'Albania', region: 'Europe' },
  { code: 'RO', name: 'Romania', region: 'Europe' },
  { code: 'BG', name: 'Bulgaria', region: 'Europe' },
  { code: 'MD', name: 'Moldova', region: 'Europe' },
  { code: 'UA', name: 'Ukraine', region: 'Europe' },
  { code: 'BY', name: 'Belarus', region: 'Europe' },
  { code: 'RU', name: 'Russia', region: 'Europe' },
  // ── Middle East ──
  { code: 'IL', name: 'Israel', region: 'Middle East' },
  { code: 'TR', name: 'Türkiye', region: 'Middle East' },
  { code: 'SA', name: 'Saudi Arabia', region: 'Middle East' },
  { code: 'AE', name: 'United Arab Emirates', region: 'Middle East' },
  { code: 'QA', name: 'Qatar', region: 'Middle East' },
  { code: 'KW', name: 'Kuwait', region: 'Middle East' },
  { code: 'BH', name: 'Bahrain', region: 'Middle East' },
  { code: 'OM', name: 'Oman', region: 'Middle East' },
  { code: 'JO', name: 'Jordan', region: 'Middle East' },
  { code: 'LB', name: 'Lebanon', region: 'Middle East' },
  { code: 'IQ', name: 'Iraq', region: 'Middle East' },
  { code: 'EG', name: 'Egypt', region: 'Middle East' },
  { code: 'YE', name: 'Yemen', region: 'Middle East' },
  // ── Africa ──
  { code: 'ZA', name: 'South Africa', region: 'Africa' },
  { code: 'NG', name: 'Nigeria', region: 'Africa' },
  { code: 'KE', name: 'Kenya', region: 'Africa' },
  { code: 'GH', name: 'Ghana', region: 'Africa' },
  { code: 'TZ', name: 'Tanzania', region: 'Africa' },
  { code: 'UG', name: 'Uganda', region: 'Africa' },
  { code: 'CI', name: "Côte d'Ivoire", region: 'Africa' },
  { code: 'SN', name: 'Senegal', region: 'Africa' },
  { code: 'CM', name: 'Cameroon', region: 'Africa' },
  { code: 'MA', name: 'Morocco', region: 'Africa' },
  { code: 'DZ', name: 'Algeria', region: 'Africa' },
  { code: 'TN', name: 'Tunisia', region: 'Africa' },
  { code: 'LY', name: 'Libya', region: 'Africa' },
  { code: 'ET', name: 'Ethiopia', region: 'Africa' },
  { code: 'ZM', name: 'Zambia', region: 'Africa' },
  { code: 'ZW', name: 'Zimbabwe', region: 'Africa' },
  { code: 'MU', name: 'Mauritius', region: 'Africa' },
  { code: 'MZ', name: 'Mozambique', region: 'Africa' },
  { code: 'AO', name: 'Angola', region: 'Africa' },
  { code: 'BW', name: 'Botswana', region: 'Africa' },
  { code: 'NA', name: 'Namibia', region: 'Africa' },
  { code: 'RW', name: 'Rwanda', region: 'Africa' },
  { code: 'CD', name: 'DR Congo', region: 'Africa' },
  // ── Asia ──
  { code: 'IN', name: 'India', region: 'Asia' },
  { code: 'PK', name: 'Pakistan', region: 'Asia' },
  { code: 'BD', name: 'Bangladesh', region: 'Asia' },
  { code: 'LK', name: 'Sri Lanka', region: 'Asia' },
  { code: 'NP', name: 'Nepal', region: 'Asia' },
  { code: 'AF', name: 'Afghanistan', region: 'Asia' },
  { code: 'MM', name: 'Myanmar', region: 'Asia' },
  { code: 'TH', name: 'Thailand', region: 'Asia' },
  { code: 'VN', name: 'Vietnam', region: 'Asia' },
  { code: 'KH', name: 'Cambodia', region: 'Asia' },
  { code: 'LA', name: 'Laos', region: 'Asia' },
  { code: 'MY', name: 'Malaysia', region: 'Asia' },
  { code: 'SG', name: 'Singapore', region: 'Asia' },
  { code: 'ID', name: 'Indonesia', region: 'Asia' },
  { code: 'PH', name: 'Philippines', region: 'Asia' },
  { code: 'BN', name: 'Brunei', region: 'Asia' },
  { code: 'CN', name: 'China', region: 'Asia' },
  { code: 'HK', name: 'Hong Kong', region: 'Asia' },
  { code: 'TW', name: 'Taiwan', region: 'Asia' },
  { code: 'MO', name: 'Macao', region: 'Asia' },
  { code: 'JP', name: 'Japan', region: 'Asia' },
  { code: 'KR', name: 'South Korea', region: 'Asia' },
  { code: 'KZ', name: 'Kazakhstan', region: 'Asia' },
  { code: 'UZ', name: 'Uzbekistan', region: 'Asia' },
  { code: 'KG', name: 'Kyrgyzstan', region: 'Asia' },
  { code: 'MN', name: 'Mongolia', region: 'Asia' },
  { code: 'GE', name: 'Georgia', region: 'Asia' },
  { code: 'AM', name: 'Armenia', region: 'Asia' },
  { code: 'AZ', name: 'Azerbaijan', region: 'Asia' },
  // ── Oceania ──
  { code: 'AU', name: 'Australia', region: 'Oceania' },
  { code: 'NZ', name: 'New Zealand', region: 'Oceania' },
  { code: 'FJ', name: 'Fiji', region: 'Oceania' },
  { code: 'PG', name: 'Papua New Guinea', region: 'Oceania' },
];

const BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c]));

export function countryName(code: string): string {
  return BY_CODE.get(code.toUpperCase())?.name ?? code.toUpperCase();
}

export function isKnownCountry(code: string): boolean {
  return BY_CODE.has(code.toUpperCase());
}
