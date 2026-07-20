/**
 * Google Ads Transparency Center — HUMONGOUS multilingual keyword exemplars.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The Google Ads Transparency Center (adstransparency.google.com) is NOT a
 * browseable feed. There is no "list all advertisers" endpoint. The ONLY way in
 * is to type a query and let Google's SearchService match it against advertiser
 * NAMES and verified DOMAINS. So the quality and breadth of the lead pull is a
 * direct function of the breadth of the keyword set you throw at it.
 *
 * This module is that keyword set: a very large, deliberately multilingual bank
 * of category / vertical / intent terms that recur inside advertiser names and
 * domains all over the world ("casino", "prestamo", "займ", "クレジット",
 * "قرض", "wettbüro", …). A keyword does NOT guarantee a mobile-app or a web-CPS
 * advertiser — the classifier decides that downstream — but a wide net across
 * languages is exactly how we surface a LOT of leads from this source.
 *
 * SHAPE
 * -----
 *   - VERTICALS            : English seed lists per lead vertical (broad).
 *   - CORE_MULTILINGUAL    : per-vertical translations of the highest-value
 *                            terms across ~35 languages / scripts.
 *   - CTA_MULTILINGUAL     : cross-vertical call-to-action / intent words per
 *                            language (download, sign up, bonus, buy now, …).
 *   - GOOGLE_ADS_LANGUAGES : language metadata (code, English + native label).
 *   - GOOGLE_ADS_VERTICALS : vertical metadata for the UI.
 *
 * The three sources are flattened into ALL_KEYWORD_ENTRIES (deduped,
 * case-insensitively), and jobs draw a bounded, well-spread sample via
 * keywordsForJob(). Nothing here hits the network; it is pure data + pure
 * functions, and ships its own offline unit tests (runGoogleAdsKeywordTests).
 *
 * MAINTENANCE
 * -----------
 * Add terms freely. The only invariants the tests enforce are: non-empty,
 * de-duplicated, trimmed, and that every vertical/language referenced by an
 * entry exists in the metadata tables.
 */

export interface GoogleAdsVerticalMeta {
  id: string;
  label: string;
  /** One-line hint shown in the UI. */
  hint: string;
}

export interface GoogleAdsLanguageMeta {
  code: string;
  label: string; // English label
  native: string; // endonym
}

export interface KeywordEntry {
  kw: string;
  vertical: string; // vertical id, or 'cta' for cross-vertical intent words
  lang: string; // language code
}

// ───────────────────────────────────────────────────────────────────────────
// Language metadata. Only languages that actually appear in the keyword bank
// are listed; the unit test asserts this table is a superset of every entry's
// language code.
// ───────────────────────────────────────────────────────────────────────────

export const GOOGLE_ADS_LANGUAGES: GoogleAdsLanguageMeta[] = [
  { code: 'en', label: 'English', native: 'English' },
  { code: 'es', label: 'Spanish', native: 'Español' },
  { code: 'pt', label: 'Portuguese', native: 'Português' },
  { code: 'fr', label: 'French', native: 'Français' },
  { code: 'de', label: 'German', native: 'Deutsch' },
  { code: 'it', label: 'Italian', native: 'Italiano' },
  { code: 'nl', label: 'Dutch', native: 'Nederlands' },
  { code: 'ru', label: 'Russian', native: 'Русский' },
  { code: 'uk', label: 'Ukrainian', native: 'Українська' },
  { code: 'pl', label: 'Polish', native: 'Polski' },
  { code: 'tr', label: 'Turkish', native: 'Türkçe' },
  { code: 'ar', label: 'Arabic', native: 'العربية' },
  { code: 'he', label: 'Hebrew', native: 'עברית' },
  { code: 'hi', label: 'Hindi', native: 'हिन्दी' },
  { code: 'bn', label: 'Bengali', native: 'বাংলা' },
  { code: 'ur', label: 'Urdu', native: 'اردو' },
  { code: 'id', label: 'Indonesian', native: 'Bahasa Indonesia' },
  { code: 'ms', label: 'Malay', native: 'Bahasa Melayu' },
  { code: 'th', label: 'Thai', native: 'ไทย' },
  { code: 'vi', label: 'Vietnamese', native: 'Tiếng Việt' },
  { code: 'ja', label: 'Japanese', native: '日本語' },
  { code: 'ko', label: 'Korean', native: '한국어' },
  { code: 'zh', label: 'Chinese (Simplified)', native: '简体中文' },
  { code: 'zh_tw', label: 'Chinese (Traditional)', native: '繁體中文' },
  { code: 'tl', label: 'Filipino', native: 'Filipino' },
  { code: 'fa', label: 'Persian', native: 'فارسی' },
  { code: 'el', label: 'Greek', native: 'Ελληνικά' },
  { code: 'ro', label: 'Romanian', native: 'Română' },
  { code: 'cs', label: 'Czech', native: 'Čeština' },
  { code: 'sk', label: 'Slovak', native: 'Slovenčina' },
  { code: 'hu', label: 'Hungarian', native: 'Magyar' },
  { code: 'sv', label: 'Swedish', native: 'Svenska' },
  { code: 'no', label: 'Norwegian', native: 'Norsk' },
  { code: 'da', label: 'Danish', native: 'Dansk' },
  { code: 'fi', label: 'Finnish', native: 'Suomi' },
  { code: 'bg', label: 'Bulgarian', native: 'Български' },
  { code: 'sr', label: 'Serbian', native: 'Српски' },
  { code: 'hr', label: 'Croatian', native: 'Hrvatski' },
  { code: 'sw', label: 'Swahili', native: 'Kiswahili' },
];

const KNOWN_LANG_CODES = new Set(GOOGLE_ADS_LANGUAGES.map((l) => l.code));

// ───────────────────────────────────────────────────────────────────────────
// Vertical metadata + English seed lists.
// ───────────────────────────────────────────────────────────────────────────

interface VerticalDef {
  meta: GoogleAdsVerticalMeta;
  en: string[];
}

const VERTICAL_DEFS: VerticalDef[] = [
  {
    meta: { id: 'igaming', label: 'iGaming / Casino', hint: 'Online casino, slots, poker, bingo' },
    en: [
      'casino', 'online casino', 'casino online', 'slots', 'online slots', 'free slots', 'spins',
      'free spins', 'jackpot', 'roulette', 'blackjack', 'poker', 'online poker', 'live casino',
      'bingo', 'baccarat', 'gambling', 'real money casino', 'casino bonus', 'no deposit bonus',
      'welcome bonus', 'cash game', 'rummy', 'teen patti', 'andar bahar', 'crash game', 'aviator',
      'plinko', 'social casino', 'sweepstakes casino', 'slot machine', 'megaways', 'video poker',
      'keno', 'scratch cards', 'best casino', 'casino app', 'win real money',
    ],
  },
  {
    meta: { id: 'betting', label: 'Sports Betting', hint: 'Sportsbook, betting, fantasy, lottery' },
    en: [
      'betting', 'sports betting', 'sportsbook', 'bet', 'online betting', 'football betting',
      'cricket betting', 'esports betting', 'betting app', 'betting site', 'odds', 'fixed odds',
      'in play betting', 'lottery', 'lotto', 'fantasy sports', 'fantasy cricket', 'fantasy football',
      'daily fantasy', 'horse racing', 'sattamatka', 'bookmaker', 'free bet', 'bet now',
    ],
  },
  {
    meta: { id: 'loans', label: 'Loans / Lending', hint: 'Personal loans, payday, cash advance' },
    en: [
      'loan', 'loans', 'personal loan', 'payday loan', 'quick loan', 'instant loan', 'cash loan',
      'online loan', 'fast cash', 'cash advance', 'installment loan', 'microloan', 'borrow money',
      'lending', 'bad credit loan', 'no credit check loan', 'title loan', 'home loan', 'car loan',
      'auto loan', 'student loan', 'business loan', 'line of credit', 'debt consolidation loan',
      'emergency loan', 'short term loan', 'loan app', 'get a loan', 'apply for a loan',
    ],
  },
  {
    meta: { id: 'credit', label: 'Credit / Debt', hint: 'Credit cards, credit repair, debt relief' },
    en: [
      'credit card', 'credit', 'credit score', 'credit repair', 'free credit report', 'debt',
      'debt consolidation', 'debt relief', 'debt settlement', 'balance transfer', 'rewards card',
      'cash back card', 'secured credit card', 'build credit', 'best credit card', 'prepaid card',
      'buy now pay later', 'bnpl',
    ],
  },
  {
    meta: { id: 'insurance', label: 'Insurance', hint: 'Auto, health, life, home insurance' },
    en: [
      'insurance', 'car insurance', 'auto insurance', 'health insurance', 'life insurance',
      'home insurance', 'travel insurance', 'pet insurance', 'dental insurance', 'term life insurance',
      'insurance quote', 'cheap insurance', 'compare insurance', 'medicare', 'final expense insurance',
      'renters insurance', 'business insurance', 'motorcycle insurance', 'insurance comparison',
    ],
  },
  {
    meta: { id: 'crypto', label: 'Crypto / Web3', hint: 'Bitcoin, exchanges, wallets, DeFi' },
    en: [
      'crypto', 'cryptocurrency', 'bitcoin', 'buy bitcoin', 'ethereum', 'crypto exchange',
      'crypto wallet', 'crypto trading', 'blockchain', 'nft', 'defi', 'stablecoin', 'altcoin',
      'crypto mining', 'crypto casino', 'web3', 'token presale', 'staking', 'crypto app',
      'best crypto exchange', 'trade crypto', 'earn crypto', 'usdt', 'memecoin',
    ],
  },
  {
    meta: { id: 'forex', label: 'Forex / Trading', hint: 'Forex, CFDs, stocks, brokers' },
    en: [
      'forex', 'forex trading', 'trading', 'online trading', 'day trading', 'cfd', 'cfd trading',
      'stock trading', 'invest', 'investing', 'investment', 'broker', 'trading platform',
      'options trading', 'commodities trading', 'indices trading', 'metatrader', 'copy trading',
      'binary options', 'trade stocks', 'trading app', 'best broker', 'demo account',
    ],
  },
  {
    meta: { id: 'ecommerce', label: 'E-commerce / Retail', hint: 'Shop, deals, fashion, gadgets' },
    en: [
      'shop', 'shop now', 'online shopping', 'store', 'buy now', 'sale', 'deals', 'discount',
      'coupon', 'coupons', 'promo code', 'free shipping', 'clearance', 'black friday', 'cyber monday',
      'dropshipping', 'marketplace', 'wholesale', 'fashion', 'clothing', 'shoes', 'sneakers',
      'handbags', 'watches', 'jewelry', 'sunglasses', 'electronics', 'gadgets', 'home decor',
      'furniture', 'kitchenware', 'cosmetics', 'skincare', 'makeup', 'perfume', 'gift ideas',
      'subscription box', 'order now', 'best price', 'limited time offer', 'flash sale', 'outlet',
    ],
  },
  {
    meta: { id: 'dating', label: 'Dating / Social', hint: 'Dating apps, singles, chat' },
    en: [
      'dating', 'dating app', 'online dating', 'singles', 'meet singles', 'hookup', 'flirt',
      'find love', 'matchmaking', 'senior dating', 'local singles', 'video chat', 'live chat',
      'chat app', 'meet people', 'find a date', 'dating site', 'speed dating', 'marriage',
    ],
  },
  {
    meta: { id: 'travel', label: 'Travel', hint: 'Flights, hotels, tours, car rental' },
    en: [
      'travel', 'flights', 'cheap flights', 'hotels', 'hotel deals', 'book hotel', 'vacation',
      'holiday', 'tours', 'cruise', 'car rental', 'travel deals', 'all inclusive', 'resort',
      'airfare', 'last minute deals', 'vacation packages', 'flight tickets', 'book flights',
      'travel insurance', 'city breaks', 'safari', 'tickets',
    ],
  },
  {
    meta: { id: 'health', label: 'Health / Pharma', hint: 'Weight loss, supplements, treatments' },
    en: [
      'weight loss', 'lose weight', 'diet', 'keto', 'keto diet', 'slimming', 'fat burner',
      'supplement', 'supplements', 'vitamins', 'collagen', 'hair loss', 'hair growth',
      'hair transplant', 'teeth whitening', 'dental implants', 'dentures', 'hearing aids', 'cbd',
      'cbd oil', 'erectile dysfunction', 'testosterone booster', 'weight loss pills', 'detox',
      'fitness', 'workout', 'muscle', 'protein', 'online pharmacy', 'prescription',
      'weight loss injection', 'glp1', 'blood sugar', 'joint pain', 'prostate', 'menopause',
    ],
  },
  {
    meta: { id: 'beauty', label: 'Beauty / Cosmetic', hint: 'Skincare, anti-aging, cosmetic surgery' },
    en: [
      'skincare', 'anti aging', 'wrinkle cream', 'acne treatment', 'botox', 'laser hair removal',
      'cosmetic surgery', 'rhinoplasty', 'hair salon', 'nails', 'lash extensions', 'facial',
      'anti wrinkle', 'serum', 'moisturizer', 'beauty products', 'clinic', 'aesthetic clinic',
    ],
  },
  {
    meta: { id: 'saas', label: 'SaaS / Software', hint: 'CRM, VPN, tools, hosting' },
    en: [
      'software', 'saas', 'crm', 'erp', 'project management', 'vpn', 'best vpn', 'antivirus',
      'cloud storage', 'web hosting', 'website builder', 'ai tool', 'ai writer', 'chatbot',
      'email marketing', 'seo', 'seo tools', 'password manager', 'invoice software',
      'accounting software', 'pos system', 'no code', 'automation tool', 'video editor',
      'design tool', 'crm software', 'hr software',
    ],
  },
  {
    meta: { id: 'realestate', label: 'Real Estate / Home', hint: 'Property, solar, home services' },
    en: [
      'real estate', 'homes for sale', 'apartments for rent', 'property', 'buy house', 'sell house',
      'mortgage', 'refinance', 'realtor', 'new homes', 'condos', 'land for sale', 'solar',
      'solar panels', 'roofing', 'hvac', 'home warranty', 'pest control', 'home security',
      'replacement windows', 'remodeling', 'plumber', 'electrician', 'moving services',
      'cleaning services', 'gutter guard', 'bathroom remodel',
    ],
  },
  {
    meta: { id: 'auto', label: 'Automotive', hint: 'Cars, used cars, EV, auto services' },
    en: [
      'car', 'cars for sale', 'used cars', 'new cars', 'car deals', 'car lease', 'auto parts',
      'tires', 'car repair', 'ev', 'electric car', 'sell my car', 'car finance', 'suv', 'truck',
      'car dealership', 'test drive', 'car warranty', 'auto loan', 'best cars',
    ],
  },
  {
    meta: { id: 'education', label: 'Education / Jobs', hint: 'Courses, degrees, jobs, make money' },
    en: [
      'online course', 'courses', 'learn', 'online degree', 'mba', 'coding bootcamp',
      'language learning', 'learn english', 'certification', 'training', 'tutoring', 'scholarships',
      'jobs', 'job search', 'hiring', 'work from home', 'remote jobs', 'career', 'resume builder',
      'recruitment', 'freelance', 'side hustle', 'make money online', 'earn money', 'passive income',
      'online school', 'study abroad', 'nursing school', 'trade school',
    ],
  },
  {
    meta: { id: 'streaming', label: 'Streaming / Games', hint: 'IPTV, streaming, mobile games' },
    en: [
      'streaming', 'watch movies', 'live tv', 'iptv', 'stream', 'sports streaming', 'music app',
      'podcast', 'ebook', 'audiobook', 'mobile game', 'play free', 'download game', 'rpg game',
      'puzzle game', 'match 3', 'card game', 'strategy game', 'idle game', 'io game', 'free to play',
      'install now', 'download now', 'play now', 'best mobile game',
    ],
  },
  {
    meta: { id: 'utilities', label: 'Telecom / Energy', hint: 'Mobile plans, broadband, energy' },
    en: [
      'mobile plan', 'sim card', 'prepaid', 'unlimited data', 'broadband', 'internet plan',
      'electricity', 'gas supplier', 'energy', 'solar quote', 'phone deals', '5g', 'esim',
      'cheap electricity', 'switch energy', 'fibre broadband',
    ],
  },
  {
    meta: { id: 'legal', label: 'Legal / Claims', hint: 'Lawyers, injury claims, settlements' },
    en: [
      'lawyer', 'attorney', 'personal injury lawyer', 'car accident lawyer', 'divorce lawyer',
      'immigration lawyer', 'bail bonds', 'legal help', 'class action', 'settlement',
      'compensation claim', 'accident claim', 'injury claim', 'workers comp', 'mesothelioma',
      'lawsuit', 'legal advice', 'no win no fee',
    ],
  },
  {
    meta: { id: 'food', label: 'Food / Delivery', hint: 'Food delivery, meal kits, groceries' },
    en: [
      'food delivery', 'order food', 'food delivery app', 'meal kit', 'meal kits', 'meal delivery',
      'grocery delivery', 'online grocery', 'grocery app', 'restaurant', 'restaurants near me',
      'takeaway', 'takeout', 'food near me', 'diet plan', 'diet meal plan', 'recipe app',
      'coffee subscription', 'meal prep', 'meal prep delivery', 'order online', 'food ordering',
      'fast food delivery', 'pizza delivery', 'sushi delivery', 'healthy meals', 'weight loss meals',
      'grocery deals', 'food discount', 'restaurant deals', 'cloud kitchen', 'ghost kitchen',
      'catering', 'food subscription', 'snack box', 'organic food delivery', 'vegan meal delivery',
      'dinner delivery', 'lunch delivery', 'breakfast delivery', 'drink delivery', 'alcohol delivery',
    ],
  },
];

export const GOOGLE_ADS_VERTICALS: GoogleAdsVerticalMeta[] = VERTICAL_DEFS.map((v) => v.meta);
const KNOWN_VERTICAL_IDS = new Set([...VERTICAL_DEFS.map((v) => v.meta.id), 'cta']);

// ───────────────────────────────────────────────────────────────────────────
// CORE_MULTILINGUAL: per-vertical translations of the highest-value terms.
// Cells hold 1-6 native-language terms. Omissions are fine; the builder simply
// includes whatever is present. Accuracy over exhaustiveness for non-Latin
// scripts — every term below is a real, commonly-advertised category word.
// ───────────────────────────────────────────────────────────────────────────

type LangMap = Partial<Record<string, string[]>>;

const CORE_MULTILINGUAL: Partial<Record<string, LangMap>> = {
  igaming: {
    es: ['casino online', 'tragamonedas', 'ruleta', 'casino en vivo', 'giros gratis', 'apuestas casino'],
    pt: ['casino online', 'cassino online', 'caça niquel', 'roleta', 'giros grátis', 'jogos de casino'],
    fr: ['casino en ligne', 'machine à sous', 'roulette', 'tours gratuits', 'casino live'],
    de: ['online casino', 'spielautomaten', 'freispiele', 'roulette', 'echtgeld casino'],
    it: ['casino online', 'slot machine', 'giri gratis', 'roulette', 'casinò live'],
    nl: ['online casino', 'gokkast', 'gratis spins', 'roulette'],
    ru: ['казино', 'онлайн казино', 'игровые автоматы', 'слоты', 'фриспины', 'рулетка'],
    uk: ['казино', 'онлайн казино', 'ігрові автомати', 'слоти'],
    pl: ['kasyno online', 'automaty do gier', 'darmowe spiny', 'ruletka'],
    tr: ['casino', 'slot oyunları', 'canlı casino', 'bonus veren siteler', 'bahis'],
    ar: ['كازينو', 'كازينو اون لاين', 'ماكينات القمار', 'روليت'],
    he: ['קזינו', 'קזינו אונליין', 'מכונות מזל', 'רולטה'],
    hi: ['कैसीनो', 'ऑनलाइन कैसीनो', 'तीन पत्ती', 'अंदर बाहर', 'स्लॉट'],
    bn: ['ক্যাসিনো', 'অনলাইন ক্যাসিনো', 'স্লট'],
    id: ['casino online', 'slot online', 'judi online', 'slot gacor', 'situs slot'],
    ms: ['kasino dalam talian', 'slot online', 'permainan slot'],
    th: ['คาสิโน', 'คาสิโนออนไลน์', 'สล็อต', 'สล็อตออนไลน์', 'บาคาร่า'],
    vi: ['casino', 'sòng bạc', 'nổ hũ', 'slot', 'cá cược'],
    ja: ['オンラインカジノ', 'カジノ', 'スロット', 'ルーレット', 'バカラ'],
    ko: ['카지노', '온라인카지노', '슬롯', '바카라', '카지노사이트'],
    zh: ['娱乐城', '在线赌场', '老虎机', '真人娱乐', '百家乐'],
    zh_tw: ['娛樂城', '線上賭場', '老虎機', '百家樂'],
    tl: ['online casino', 'slots', 'sugal online', 'jili slots'],
    fa: ['کازینو', 'کازینو آنلاین', 'اسلات', 'شرط بندی'],
    el: ['καζίνο', 'φρουτάκια', 'διαδικτυακό καζίνο', 'ρουλέτα'],
    ro: ['cazino online', 'păcănele', 'rotiri gratuite', 'ruletă'],
    cs: ['online casino', 'automaty', 'ruleta', 'free spiny'],
    hu: ['online kaszinó', 'nyerőgépek', 'rulett'],
    sv: ['casino online', 'spelautomater', 'free spins'],
    no: ['nettcasino', 'spilleautomater', 'gratisspinn'],
    da: ['online casino', 'spilleautomater', 'free spins'],
    fi: ['nettikasino', 'kolikkopelit', 'ilmaiskierrokset'],
    bg: ['казино', 'онлайн казино', 'ротативки', 'слот игри'],
    sr: ['онлајн казино', 'слот игре', 'рулет'],
    hr: ['online casino', 'slot igre', 'besplatni spinovi'],
    sw: ['kasino', 'kasino mtandaoni', 'slots'],
  },
  betting: {
    es: ['apuestas deportivas', 'casa de apuestas', 'apuestas online', 'lotería'],
    pt: ['apostas esportivas', 'casa de apostas', 'apostas online', 'loteria', 'jogo do bicho'],
    fr: ['paris sportifs', 'pari sportif', 'bookmaker', 'loterie'],
    de: ['sportwetten', 'wettbüro', 'wetten', 'lotto'],
    it: ['scommesse sportive', 'scommesse online', 'lotteria'],
    nl: ['sportweddenschappen', 'wedden', 'loterij'],
    ru: ['ставки на спорт', 'букмекерская контора', 'бетинг', 'лотерея'],
    uk: ['ставки на спорт', 'букмекерська контора', 'лотерея'],
    pl: ['zakłady bukmacherskie', 'zakłady sportowe', 'lotto'],
    tr: ['spor bahisleri', 'bahis siteleri', 'iddaa', 'canlı bahis'],
    ar: ['المراهنات الرياضية', 'الرهان', 'يانصيب'],
    he: ['הימורי ספורט', 'הימורים', 'לוטו'],
    hi: ['सट्टा', 'क्रिकेट सट्टेबाजी', 'सट्टा मटका', 'लॉटरी'],
    bn: ['বাজি', 'ক্রিকেট বেটিং', 'লটারি'],
    id: ['taruhan bola', 'judi bola', 'sbobet', 'togel'],
    ms: ['pertaruhan sukan', 'judi bola', 'loteri'],
    th: ['พนันบอล', 'แทงบอล', 'เว็บพนัน', 'หวย', 'หวยออนไลน์'],
    vi: ['cá cược bóng đá', 'cá độ', 'lô đề', 'xổ số'],
    ja: ['スポーツベット', 'ブックメーカー', 'ロト', '宝くじ'],
    ko: ['스포츠토토', '베팅', '토토사이트', '복권'],
    zh: ['体育博彩', '博彩', '彩票', '六合彩'],
    zh_tw: ['體育博彩', '運彩', '彩票', '六合彩'],
    tl: ['sports betting', 'pustahan', 'lotto', 'e-sabong'],
    fa: ['شرط بندی ورزشی', 'پیش بینی فوتبال', 'لاتاری'],
    el: ['στοίχημα', 'αθλητικό στοίχημα', 'λαχείο'],
    ro: ['pariuri sportive', 'casă de pariuri', 'loterie'],
    cs: ['sázení', 'sportovní sázky', 'loterie'],
    hu: ['sportfogadás', 'fogadóiroda', 'lottó'],
    sv: ['sportspel', 'betting', 'odds'],
    no: ['sportsbetting', 'oddsspill', 'lotto'],
    da: ['sportsbetting', 'oddset', 'lotto'],
    fi: ['vedonlyönti', 'urheiluvedonlyönti', 'lotto'],
    bg: ['спортни залози', 'залагания', 'тото'],
    sw: ['kubet michezo', 'betting', 'bahati nasibu'],
  },
  loans: {
    es: ['préstamo', 'préstamos personales', 'crédito rápido', 'dinero urgente', 'minicréditos'],
    pt: ['empréstimo', 'empréstimo pessoal', 'crédito rápido', 'dinheiro rápido', 'empréstimo online'],
    fr: ['prêt', 'prêt personnel', 'crédit rapide', 'microcrédit', 'rachat de crédit'],
    de: ['kredit', 'sofortkredit', 'ratenkredit', 'privatkredit', 'geld leihen'],
    it: ['prestito', 'prestiti personali', 'prestito veloce', 'cessione del quinto'],
    nl: ['lening', 'persoonlijke lening', 'minilening', 'geld lenen'],
    ru: ['займ', 'займ онлайн', 'кредит', 'микрозайм', 'деньги в долг', 'кредит наличными'],
    uk: ['кредит', 'кредит онлайн', 'позика', 'мікрозайм', 'гроші в борг'],
    pl: ['pożyczka', 'chwilówka', 'kredyt gotówkowy', 'pożyczka online'],
    tr: ['kredi', 'ihtiyaç kredisi', 'hızlı kredi', 'nakit avans'],
    ar: ['قرض', 'قروض شخصية', 'تمويل شخصي', 'قرض سريع'],
    he: ['הלוואה', 'הלוואות', 'הלוואה מהירה', 'אשראי'],
    hi: ['लोन', 'पर्सनल लोन', 'तुरंत लोन', 'लोन ऐप', 'नकद ऋण'],
    bn: ['ঋণ', 'পার্সোনাল লোন', 'তাত্ক্ষণিক ঋণ'],
    id: ['pinjaman', 'pinjaman online', 'pinjol', 'kredit', 'dana cepat', 'kta'],
    ms: ['pinjaman', 'pinjaman peribadi', 'pinjaman segera', 'wang tunai'],
    th: ['สินเชื่อ', 'เงินกู้', 'กู้เงินด่วน', 'สินเชื่อออนไลน์', 'เงินด่วน'],
    vi: ['vay tiền', 'vay nhanh', 'vay online', 'vay tín chấp'],
    ja: ['カードローン', 'キャッシング', '消費者金融', '借入', 'お金を借りる'],
    ko: ['대출', '신용대출', '급전', '비상금대출', '소액대출'],
    zh: ['贷款', '小额贷款', '快速贷款', '现金贷', '网贷'],
    zh_tw: ['貸款', '小額貸款', '信用貸款', '現金周轉'],
    tl: ['loan', 'utang online', 'pautang', 'sangla', 'cash loan'],
    fa: ['وام', 'وام فوری', 'تسهیلات', 'قرض'],
    el: ['δάνειο', 'προσωπικό δάνειο', 'γρήγορο δάνειο'],
    ro: ['împrumut', 'credit rapid', 'împrumut online', 'credit nevoi personale'],
    cs: ['půjčka', 'rychlá půjčka', 'půjčka online', 'úvěr'],
    hu: ['kölcsön', 'gyorskölcsön', 'személyi kölcsön', 'hitel'],
    sv: ['lån', 'snabblån', 'privatlån', 'smslån'],
    no: ['lån', 'forbrukslån', 'smålån', 'kredittlån'],
    da: ['lån', 'kviklån', 'forbrugslån', 'smålån'],
    fi: ['laina', 'pikavippi', 'kulutusluotto', 'vippi'],
    bg: ['кредит', 'бърз кредит', 'заем', 'паричен заем'],
    sr: ['кредит', 'брзи кредит', 'позајмица'],
    hr: ['kredit', 'brzi kredit', 'zajam', 'gotovinski kredit'],
    sw: ['mkopo', 'mkopo wa haraka', 'mkopo mtandaoni'],
  },
  insurance: {
    es: ['seguro', 'seguro de coche', 'seguro médico', 'seguro de vida', 'seguro de hogar'],
    pt: ['seguro', 'seguro auto', 'seguro de saúde', 'seguro de vida', 'plano de saúde'],
    fr: ['assurance', 'assurance auto', 'mutuelle santé', 'assurance vie', 'assurance habitation'],
    de: ['versicherung', 'kfz versicherung', 'krankenversicherung', 'lebensversicherung'],
    it: ['assicurazione', 'assicurazione auto', 'assicurazione sanitaria', 'assicurazione vita'],
    nl: ['verzekering', 'autoverzekering', 'zorgverzekering', 'levensverzekering'],
    ru: ['страховка', 'осаго', 'каско', 'страхование жизни', 'медицинская страховка'],
    uk: ['страхування', 'автострахування', 'страхування життя'],
    pl: ['ubezpieczenie', 'ubezpieczenie samochodu', 'ubezpieczenie na życie'],
    tr: ['sigorta', 'kasko', 'trafik sigortası', 'sağlık sigortası', 'hayat sigortası'],
    ar: ['تأمين', 'تأمين سيارات', 'تأمين صحي', 'تأمين على الحياة'],
    he: ['ביטוח', 'ביטוח רכב', 'ביטוח בריאות', 'ביטוח חיים'],
    hi: ['बीमा', 'कार बीमा', 'स्वास्थ्य बीमा', 'जीवन बीमा'],
    id: ['asuransi', 'asuransi mobil', 'asuransi kesehatan', 'asuransi jiwa'],
    ms: ['insurans', 'insurans kereta', 'insurans kesihatan', 'takaful'],
    th: ['ประกัน', 'ประกันรถยนต์', 'ประกันสุขภาพ', 'ประกันชีวิต'],
    vi: ['bảo hiểm', 'bảo hiểm ô tô', 'bảo hiểm sức khỏe', 'bảo hiểm nhân thọ'],
    ja: ['保険', '自動車保険', '医療保険', '生命保険', '保険見直し'],
    ko: ['보험', '자동차보험', '실손보험', '생명보험', '보험비교'],
    zh: ['保险', '车险', '医疗保险', '人寿保险'],
    zh_tw: ['保險', '車險', '醫療保險', '壽險'],
    tl: ['insurance', 'car insurance', 'health insurance', 'life insurance'],
    fa: ['بیمه', 'بیمه خودرو', 'بیمه درمانی', 'بیمه عمر'],
    el: ['ασφάλεια', 'ασφάλεια αυτοκινήτου', 'ασφάλεια ζωής'],
    ro: ['asigurare', 'asigurare auto', 'asigurare de viață', 'rca'],
    cs: ['pojištění', 'pojištění auta', 'životní pojištění'],
    hu: ['biztosítás', 'autó biztosítás', 'életbiztosítás'],
    sv: ['försäkring', 'bilförsäkring', 'livförsäkring'],
    no: ['forsikring', 'bilforsikring', 'livsforsikring'],
    da: ['forsikring', 'bilforsikring', 'livsforsikring'],
    fi: ['vakuutus', 'autovakuutus', 'henkivakuutus'],
    bg: ['застраховка', 'автомобилна застраховка', 'здравна застраховка'],
    sw: ['bima', 'bima ya gari', 'bima ya afya'],
  },
  crypto: {
    es: ['comprar bitcoin', 'criptomonedas', 'exchange cripto', 'billetera cripto', 'invertir en cripto'],
    pt: ['comprar bitcoin', 'criptomoedas', 'corretora de criptomoedas', 'carteira cripto'],
    fr: ['acheter bitcoin', 'crypto monnaie', 'échange crypto', 'portefeuille crypto'],
    de: ['bitcoin kaufen', 'kryptowährung', 'krypto börse', 'krypto wallet'],
    it: ['comprare bitcoin', 'criptovalute', 'exchange crypto', 'wallet crypto'],
    nl: ['bitcoin kopen', 'cryptocurrency', 'crypto exchange'],
    ru: ['криптовалюта', 'купить биткоин', 'криптобиржа', 'крипто кошелек'],
    uk: ['криптовалюта', 'купити біткоїн', 'криптобіржа'],
    pl: ['kryptowaluty', 'kup bitcoin', 'giełda krypto'],
    tr: ['kripto para', 'bitcoin al', 'kripto borsası'],
    ar: ['العملات الرقمية', 'شراء بيتكوين', 'منصة تداول العملات الرقمية'],
    he: ['מטבעות דיגיטליים', 'קניית ביטקוין', 'קריפטו'],
    hi: ['क्रिप्टो', 'बिटकॉइन खरीदें', 'क्रिप्टोकरेंसी'],
    id: ['kripto', 'beli bitcoin', 'aset kripto', 'exchange kripto'],
    ms: ['kripto', 'beli bitcoin', 'mata wang kripto'],
    th: ['คริปโต', 'ซื้อบิทคอยน์', 'เทรดคริปโต', 'สกุลเงินดิจิทัล'],
    vi: ['tiền điện tử', 'mua bitcoin', 'sàn giao dịch crypto'],
    ja: ['仮想通貨', 'ビットコイン', '暗号資産', '仮想通貨取引所'],
    ko: ['가상화폐', '비트코인', '코인거래소', '암호화폐'],
    zh: ['加密货币', '买比特币', '数字货币交易所', '虚拟货币'],
    zh_tw: ['加密貨幣', '買比特幣', '虛擬貨幣交易所'],
    tl: ['crypto', 'bumili ng bitcoin', 'cryptocurrency'],
    fa: ['ارز دیجیتال', 'خرید بیت کوین', 'صرافی ارز دیجیتال'],
    el: ['κρυπτονομίσματα', 'αγορά bitcoin'],
    ro: ['criptomonede', 'cumpără bitcoin', 'schimb crypto'],
    cs: ['kryptoměny', 'koupit bitcoin', 'krypto burza'],
    hu: ['kriptovaluta', 'bitcoin vásárlás', 'kripto tőzsde'],
    sv: ['kryptovaluta', 'köpa bitcoin'],
    no: ['kryptovaluta', 'kjøpe bitcoin'],
    fi: ['kryptovaluutta', 'osta bitcoin'],
    bg: ['криптовалута', 'купи биткойн'],
    sw: ['sarafu ya kidijitali', 'nunua bitcoin'],
  },
  forex: {
    es: ['trading', 'trading online', 'invertir', 'bróker', 'operar en bolsa'],
    pt: ['trading', 'investimentos', 'corretora', 'operar forex', 'day trade'],
    fr: ['trading', 'trading en ligne', 'investir', 'courtier', 'bourse'],
    de: ['trading', 'online broker', 'investieren', 'aktien handeln', 'daytrading'],
    it: ['trading', 'trading online', 'investire', 'broker', 'fare trading'],
    nl: ['traden', 'beleggen', 'online broker'],
    ru: ['трейдинг', 'форекс', 'инвестиции', 'брокер', 'торговля на бирже'],
    uk: ['трейдинг', 'форекс', 'інвестиції', 'брокер'],
    pl: ['trading', 'inwestowanie', 'broker', 'giełda'],
    tr: ['yatırım', 'forex', 'borsa', 'hisse senedi'],
    ar: ['تداول', 'الفوركس', 'استثمار', 'وسيط تداول'],
    he: ['מסחר', 'השקעות', 'פורקס', 'ברוקר'],
    hi: ['ट्रेडिंग', 'शेयर बाजार', 'निवेश', 'डीमैट खाता'],
    id: ['trading', 'investasi', 'saham', 'broker forex'],
    ms: ['dagangan', 'pelaburan', 'saham', 'forex'],
    th: ['เทรด', 'ลงทุน', 'หุ้น', 'เทรดหุ้น', 'forex'],
    vi: ['giao dịch', 'đầu tư', 'chứng khoán', 'sàn forex'],
    ja: ['fx', '投資', '株取引', 'トレード', 'ネット証券'],
    ko: ['주식', '투자', '해외선물', '트레이딩', '재테크'],
    zh: ['炒股', '投资', '外汇交易', '股票开户'],
    zh_tw: ['股票', '投資', '外匯交易', '證券開戶'],
    tl: ['trading', 'investment', 'stocks', 'forex'],
    fa: ['ترید', 'سرمایه گذاری', 'فارکس', 'بورس'],
    el: ['trading', 'επενδύσεις', 'χρηματιστήριο'],
    ro: ['tranzacționare', 'investiții', 'broker', 'bursă'],
    cs: ['obchodování', 'investování', 'broker', 'akcie'],
    hu: ['kereskedés', 'befektetés', 'tőzsde', 'részvény'],
    sv: ['trading', 'investera', 'aktier'],
    no: ['trading', 'investere', 'aksjer'],
    fi: ['sijoittaminen', 'osakkeet', 'treidaus'],
    sw: ['biashara ya hisa', 'uwekezaji', 'forex'],
  },
  ecommerce: {
    es: ['comprar online', 'tienda online', 'ofertas', 'descuento', 'envío gratis', 'rebajas'],
    pt: ['comprar online', 'loja online', 'ofertas', 'desconto', 'frete grátis', 'promoção'],
    fr: ['acheter en ligne', 'boutique en ligne', 'promotions', 'soldes', 'livraison gratuite'],
    de: ['online shop', 'jetzt kaufen', 'angebote', 'rabatt', 'gratis versand', 'sale'],
    it: ['acquista online', 'negozio online', 'offerte', 'sconto', 'spedizione gratis', 'saldi'],
    nl: ['online winkelen', 'aanbiedingen', 'korting', 'uitverkoop', 'gratis verzending'],
    ru: ['интернет магазин', 'купить онлайн', 'скидки', 'распродажа', 'акции'],
    uk: ['інтернет магазин', 'купити онлайн', 'знижки', 'розпродаж'],
    pl: ['sklep internetowy', 'kup online', 'promocje', 'wyprzedaż', 'zniżka'],
    tr: ['online alışveriş', 'indirim', 'kampanya', 'ücretsiz kargo', 'fırsatlar'],
    ar: ['تسوق اونلاين', 'متجر الكتروني', 'عروض', 'خصم', 'شحن مجاني'],
    he: ['קניות אונליין', 'חנות אונליין', 'מבצעים', 'הנחה', 'משלוח חינם'],
    hi: ['ऑनलाइन शॉपिंग', 'ऑफर', 'छूट', 'सेल'],
    id: ['belanja online', 'toko online', 'promo', 'diskon', 'gratis ongkir'],
    ms: ['beli belah online', 'kedai online', 'promosi', 'diskaun'],
    th: ['ช้อปปิ้งออนไลน์', 'ร้านค้าออนไลน์', 'โปรโมชั่น', 'ส่วนลด', 'ส่งฟรี'],
    vi: ['mua sắm online', 'cửa hàng online', 'khuyến mãi', 'giảm giá', 'miễn phí vận chuyển'],
    ja: ['通販', 'オンラインショップ', 'セール', '送料無料', '激安'],
    ko: ['온라인쇼핑', '쇼핑몰', '할인', '무료배송', '특가'],
    zh: ['网购', '网上商城', '优惠', '折扣', '包邮'],
    zh_tw: ['網購', '網路商店', '優惠', '折扣', '免運'],
    tl: ['online shopping', 'sale', 'diskwento', 'libreng shipping'],
    fa: ['خرید اینترنتی', 'فروشگاه اینترنتی', 'تخفیف', 'حراج'],
    el: ['ηλεκτρονικό κατάστημα', 'προσφορές', 'εκπτώσεις'],
    ro: ['cumpără online', 'magazin online', 'reduceri', 'transport gratuit'],
    cs: ['nákup online', 'e-shop', 'slevy', 'výprodej'],
    hu: ['online vásárlás', 'webshop', 'akció', 'kedvezmény'],
    sv: ['handla online', 'rea', 'erbjudanden', 'fri frakt'],
    no: ['handle online', 'salg', 'tilbud', 'gratis frakt'],
    da: ['shop online', 'udsalg', 'tilbud', 'gratis fragt'],
    fi: ['verkkokauppa', 'alennus', 'tarjoukset', 'ilmainen toimitus'],
    bg: ['онлайн магазин', 'намаления', 'промоции'],
    sw: ['ununuzi mtandaoni', 'punguzo', 'ofa'],
  },
  dating: {
    es: ['citas', 'app de citas', 'conocer gente', 'solteros', 'buscar pareja'],
    pt: ['namoro', 'app de namoro', 'conhecer pessoas', 'solteiros', 'encontros'],
    fr: ['rencontre', 'site de rencontre', 'célibataires', 'appli de rencontre'],
    de: ['dating', 'singlebörse', 'partnersuche', 'flirten', 'leute kennenlernen'],
    it: ['incontri', 'app di incontri', 'single', 'chat incontri'],
    nl: ['daten', 'datingsite', 'singles', 'relatie'],
    ru: ['знакомства', 'сайт знакомств', 'найти пару', 'чат знакомств'],
    uk: ['знайомства', 'сайт знайомств', 'чат знайомств'],
    pl: ['randki', 'portal randkowy', 'poznaj kogoś', 'single'],
    tr: ['arkadaşlık', 'flört', 'sohbet', 'tanışma'],
    ar: ['مواعدة', 'تعارف', 'دردشة', 'زواج'],
    he: ['הכרויות', 'אתר הכרויות', 'דייטים', "צ'אט"],
    hi: ['डेटिंग', 'डेटिंग ऐप', 'दोस्ती', 'शादी'],
    id: ['kencan', 'aplikasi kencan', 'cari jodoh', 'chat'],
    ms: ['temu janji', 'cari pasangan', 'sembang'],
    th: ['หาคู่', 'หาแฟน', 'แอพหาคู่', 'เดท'],
    vi: ['hẹn hò', 'app hẹn hò', 'tìm bạn', 'kết bạn'],
    ja: ['マッチングアプリ', '出会い', '婚活', '恋活'],
    ko: ['소개팅', '데이팅앱', '만남', '채팅'],
    zh: ['相亲', '交友', '约会', '婚恋'],
    zh_tw: ['交友', '約會', '相親', '聊天'],
    tl: ['dating', 'dating app', 'chat', 'ka-date'],
    fa: ['دوستیابی', 'همسریابی', 'چت', 'آشنایی'],
    el: ['γνωριμίες', 'ραντεβού', 'σχέσεις'],
    ro: ['matrimoniale', 'întâlniri', 'cunoaște oameni'],
    cs: ['seznamka', 'seznámení', 'chat'],
    hu: ['társkereső', 'randi', 'ismerkedés'],
    sv: ['dejting', 'träffa singlar', 'dejtingapp'],
    no: ['dating', 'møt single', 'datingapp'],
    fi: ['deittailu', 'seuranhaku', 'treffit'],
    sw: ['uchumba', 'kutafuta mpenzi', 'gumzo'],
  },
  travel: {
    es: ['vuelos baratos', 'hoteles', 'vacaciones', 'ofertas de viaje', 'reservar hotel'],
    pt: ['passagens aéreas', 'hotéis', 'férias', 'pacotes de viagem', 'reservar hotel'],
    fr: ['vols pas chers', 'hôtels', 'vacances', 'séjour', 'réserver un hôtel'],
    de: ['günstige flüge', 'hotels', 'urlaub', 'reisen', 'pauschalreisen'],
    it: ['voli low cost', 'hotel', 'vacanze', 'offerte viaggio'],
    nl: ['goedkope vluchten', 'hotels', 'vakantie', 'reizen'],
    ru: ['дешевые авиабилеты', 'отели', 'туры', 'горящие туры', 'бронирование отелей'],
    uk: ['дешеві авіаквитки', 'готелі', 'тури', 'відпочинок'],
    pl: ['tanie loty', 'hotele', 'wakacje', 'wycieczki'],
    tr: ['ucuz uçak bileti', 'otel', 'tatil', 'tur'],
    ar: ['طيران رخيص', 'فنادق', 'عطلة', 'حجز فندق', 'رحلات'],
    he: ['טיסות זולות', 'מלונות', 'חופשה', 'נופש'],
    hi: ['सस्ती उड़ानें', 'होटल', 'छुट्टियां', 'टूर पैकेज'],
    id: ['tiket pesawat murah', 'hotel', 'liburan', 'paket wisata'],
    ms: ['tiket kapal terbang murah', 'hotel', 'percutian', 'pakej pelancongan'],
    th: ['ตั๋วเครื่องบินราคาถูก', 'โรงแรม', 'ทัวร์', 'จองโรงแรม'],
    vi: ['vé máy bay giá rẻ', 'khách sạn', 'du lịch', 'tour'],
    ja: ['格安航空券', 'ホテル', '旅行', 'ツアー', '国内旅行'],
    ko: ['항공권', '호텔', '여행', '패키지여행', '해외여행'],
    zh: ['特价机票', '酒店', '旅游', '跟团游', '订酒店'],
    zh_tw: ['特價機票', '飯店', '旅遊', '訂房'],
    tl: ['murang flight', 'hotel', 'travel', 'tour package'],
    fa: ['بلیط هواپیما ارزان', 'هتل', 'تور', 'رزرو هتل'],
    el: ['φθηνά εισιτήρια', 'ξενοδοχεία', 'διακοπές'],
    ro: ['bilete avion ieftine', 'hoteluri', 'vacanțe', 'sejur'],
    cs: ['levné letenky', 'hotely', 'dovolená', 'zájezdy'],
    hu: ['olcsó repülőjegy', 'szállás', 'nyaralás', 'utazás'],
    sv: ['billiga flyg', 'hotell', 'semester', 'resor'],
    no: ['billige flybilletter', 'hotell', 'ferie', 'reiser'],
    fi: ['halvat lennot', 'hotellit', 'loma', 'matkat'],
    bg: ['евтини самолетни билети', 'хотели', 'почивка'],
    sw: ['tikiti za ndege', 'hoteli', 'likizo', 'safari'],
  },
  health: {
    es: ['perder peso', 'adelgazar', 'bajar de peso', 'suplementos', 'caída del cabello'],
    pt: ['emagrecer', 'perder peso', 'suplementos', 'queda de cabelo', 'implante dentário'],
    fr: ['perdre du poids', 'maigrir', 'compléments alimentaires', 'chute de cheveux', 'implant dentaire'],
    de: ['abnehmen', 'gewicht verlieren', 'nahrungsergänzung', 'haarausfall', 'zahnimplantate'],
    it: ['perdere peso', 'dimagrire', 'integratori', 'caduta capelli', 'impianti dentali'],
    nl: ['afvallen', 'gewicht verliezen', 'supplementen', 'haaruitval'],
    ru: ['похудеть', 'похудение', 'бады', 'выпадение волос', 'потенция'],
    uk: ['схуднути', 'схуднення', 'добавки', 'випадіння волосся'],
    pl: ['odchudzanie', 'schudnąć', 'suplementy', 'wypadanie włosów', 'implanty zębów'],
    tr: ['kilo vermek', 'zayıflama', 'takviye', 'saç ekimi', 'diş implantı'],
    ar: ['خسارة الوزن', 'تخسيس', 'مكملات غذائية', 'زراعة الشعر', 'زراعة الأسنان'],
    he: ['ירידה במשקל', 'הרזיה', 'תוספי תזונה', 'השתלת שיער', 'השתלת שיניים'],
    hi: ['वजन कम करें', 'मोटापा कम', 'सप्लीमेंट', 'बाल झड़ना', 'दांत प्रत्यारोपण'],
    id: ['menurunkan berat badan', 'diet', 'suplemen', 'rambut rontok', 'implan gigi'],
    ms: ['turun berat badan', 'kurus', 'suplemen', 'gugur rambut'],
    th: ['ลดน้ำหนัก', 'ลดความอ้วน', 'อาหารเสริม', 'ผมร่วง', 'รากฟันเทียม'],
    vi: ['giảm cân', 'giảm béo', 'thực phẩm chức năng', 'rụng tóc', 'trồng răng implant'],
    ja: ['ダイエット', '痩せる', 'サプリ', '育毛', '薄毛', 'インプラント', '脱毛'],
    ko: ['다이어트', '체중감량', '건강기능식품', '탈모', '임플란트', '보톡스'],
    zh: ['减肥', '瘦身', '保健品', '脱发', '种植牙', '医美'],
    zh_tw: ['減肥', '瘦身', '保健食品', '掉髮', '植牙', '醫美'],
    tl: ['pumayat', 'weight loss', 'supplements', 'pagkalbo'],
    fa: ['کاهش وزن', 'لاغری', 'مکمل', 'ریزش مو', 'کاشت مو', 'ایمپلنت دندان'],
    el: ['απώλεια βάρους', 'αδυνάτισμα', 'συμπληρώματα', 'μεταμόσχευση μαλλιών'],
    ro: ['slăbit', 'pierdere în greutate', 'suplimente', 'căderea părului', 'implant dentar'],
    cs: ['hubnutí', 'zhubnout', 'doplňky stravy', 'vypadávání vlasů'],
    hu: ['fogyás', 'lefogyni', 'táplálékkiegészítő', 'hajhullás', 'fogbeültetés'],
    sv: ['gå ner i vikt', 'viktminskning', 'kosttillskott', 'håravfall'],
    no: ['gå ned i vekt', 'vekttap', 'kosttilskudd', 'hårtap'],
    fi: ['laihdutus', 'painonpudotus', 'ravintolisät', 'hiustenlähtö'],
    bg: ['отслабване', 'хранителни добавки', 'косопад', 'зъбни импланти'],
    sw: ['kupunguza uzito', 'virutubisho', 'kunyonyoka nywele'],
  },
  saas: {
    es: ['mejor vpn', 'vpn gratis', 'antivirus'],
    pt: ['melhor vpn', 'vpn grátis', 'antivírus'],
    fr: ['meilleur vpn', 'vpn gratuit', 'antivirus'],
    de: ['beste vpn', 'vpn kostenlos', 'antivirus'],
    it: ['migliore vpn', 'vpn gratis', 'antivirus'],
    ru: ['впн', 'лучший vpn', 'антивирус'],
    tr: ['vpn', 'ücretsiz vpn', 'antivirüs'],
    ar: ['في بي ان', 'برنامج vpn', 'مضاد فيروسات'],
    hi: ['वीपीएन', 'फ्री वीपीएन', 'एंटीवायरस'],
    id: ['vpn terbaik', 'vpn gratis', 'antivirus'],
    th: ['vpn', 'วีพีเอ็น', 'แอนตี้ไวรัส'],
    vi: ['vpn tốt nhất', 'vpn miễn phí', 'phần mềm diệt virus'],
    ja: ['vpn', 'おすすめvpn', 'ウイルス対策'],
    ko: ['vpn', '무료 vpn', '백신 프로그램'],
    zh: ['翻墙', '加速器', '杀毒软件'],
    fa: ['وی پی ان', 'فیلترشکن', 'آنتی ویروس'],
  },
  education: {
    es: ['curso online', 'aprender inglés', 'estudiar online', 'formación', 'ganar dinero online'],
    pt: ['curso online', 'aprender inglês', 'faculdade a distância', 'ganhar dinheiro online', 'renda extra'],
    fr: ['formation en ligne', 'apprendre l anglais', 'cours en ligne', 'gagner de l argent'],
    de: ['online kurs', 'englisch lernen', 'weiterbildung', 'geld verdienen online'],
    it: ['corso online', 'imparare inglese', 'formazione online', 'guadagnare online'],
    nl: ['online cursus', 'engels leren', 'geld verdienen online'],
    ru: ['онлайн курсы', 'выучить английский', 'обучение', 'заработок в интернете', 'удаленная работа'],
    uk: ['онлайн курси', 'вивчити англійську', 'заробіток в інтернеті'],
    pl: ['kurs online', 'nauka angielskiego', 'zarabianie w internecie', 'praca zdalna'],
    tr: ['online kurs', 'ingilizce öğren', 'evden iş', 'para kazan'],
    ar: ['دورة اونلاين', 'تعلم الانجليزية', 'العمل من المنزل', 'ربح المال'],
    he: ['קורס אונליין', 'ללמוד אנגלית', 'עבודה מהבית', 'להרוויח כסף'],
    hi: ['ऑनलाइन कोर्स', 'अंग्रेजी सीखें', 'घर बैठे काम', 'पैसे कमाएं'],
    id: ['kursus online', 'belajar bahasa inggris', 'kerja online', 'penghasilan tambahan'],
    ms: ['kursus online', 'belajar bahasa inggeris', 'kerja dari rumah'],
    th: ['คอร์สออนไลน์', 'เรียนภาษาอังกฤษ', 'งานออนไลน์', 'หารายได้เสริม'],
    vi: ['khóa học online', 'học tiếng anh', 'việc làm online', 'kiếm tiền online'],
    ja: ['オンライン講座', '英会話', '副業', '在宅ワーク', '資格'],
    ko: ['온라인 강의', '영어회화', '부업', '재택근무', '자격증'],
    zh: ['在线课程', '学英语', '在家工作', '网上赚钱', '兼职'],
    zh_tw: ['線上課程', '學英文', '在家工作', '網路賺錢'],
    tl: ['online course', 'matuto ng english', 'work from home', 'kumita online'],
    fa: ['دوره آنلاین', 'یادگیری زبان', 'کار در منزل', 'کسب درآمد'],
    el: ['μαθήματα online', 'αγγλικά', 'εργασία από το σπίτι'],
    ro: ['curs online', 'învață engleză', 'muncă de acasă', 'câștigă bani online'],
    cs: ['online kurz', 'učit se anglicky', 'práce z domova'],
    hu: ['online tanfolyam', 'angol tanulás', 'otthoni munka', 'pénzkeresés'],
    sv: ['onlinekurs', 'lär dig engelska', 'jobba hemifrån'],
    sw: ['kozi mtandaoni', 'jifunze kiingereza', 'kazi ya mtandaoni', 'pata pesa mtandaoni'],
  },
  realestate: {
    es: ['pisos en venta', 'casas en venta', 'alquiler', 'inmobiliaria', 'placas solares'],
    pt: ['imóveis à venda', 'apartamentos', 'aluguel', 'financiamento imobiliário', 'energia solar'],
    fr: ['immobilier', 'appartement à vendre', 'maison à vendre', 'panneaux solaires'],
    de: ['immobilien', 'wohnung kaufen', 'haus kaufen', 'solaranlage', 'photovoltaik'],
    it: ['case in vendita', 'appartamenti', 'immobiliare', 'pannelli solari'],
    nl: ['huizen te koop', 'appartement huren', 'zonnepanelen'],
    ru: ['недвижимость', 'квартиры', 'купить квартиру', 'ипотека', 'солнечные панели'],
    tr: ['satılık daire', 'emlak', 'kiralık ev', 'güneş paneli'],
    ar: ['عقارات', 'شقق للبيع', 'ألواح شمسية'],
    he: ['נדל"ן', 'דירות למכירה', 'משכנתא', 'פאנלים סולאריים'],
    hi: ['प्रॉपर्टी', 'फ्लैट', 'घर खरीदें', 'सोलर पैनल'],
    id: ['rumah dijual', 'properti', 'kpr', 'panel surya'],
    th: ['บ้านมือสอง', 'คอนโด', 'อสังหาริมทรัพย์', 'โซลาร์เซลล์'],
    vi: ['nhà đất', 'căn hộ', 'bất động sản', 'điện mặt trời'],
    ja: ['不動産', 'マンション購入', '注文住宅', '太陽光発電'],
    ko: ['부동산', '아파트', '분양', '태양광'],
    zh: ['房产', '买房', '楼盘', '太阳能'],
    zh_tw: ['房地產', '買房', '預售屋', '太陽能'],
    fa: ['املاک', 'خرید خانه', 'پنل خورشیدی'],
    ro: ['imobiliare', 'apartamente de vânzare', 'panouri solare'],
    pl: ['nieruchomości', 'mieszkania na sprzedaż', 'fotowoltaika'],
  },
  auto: {
    es: ['coches de segunda mano', 'coches nuevos', 'coche eléctrico', 'renting de coches'],
    pt: ['carros usados', 'carros novos', 'carro elétrico', 'financiamento de veículos'],
    fr: ['voiture occasion', 'voiture neuve', 'voiture électrique', 'leasing auto'],
    de: ['gebrauchtwagen', 'neuwagen', 'elektroauto', 'auto leasing'],
    it: ['auto usate', 'auto nuove', 'auto elettrica', 'noleggio auto'],
    ru: ['авто с пробегом', 'новые авто', 'электромобиль', 'автокредит'],
    tr: ['ikinci el araba', 'sıfır araba', 'elektrikli araba'],
    ar: ['سيارات مستعملة', 'سيارات جديدة', 'سيارة كهربائية'],
    hi: ['पुरानी कार', 'नई कार', 'इलेक्ट्रिक कार'],
    id: ['mobil bekas', 'mobil baru', 'mobil listrik', 'kredit mobil'],
    th: ['รถมือสอง', 'รถใหม่', 'รถไฟฟ้า', 'รถยนต์'],
    vi: ['xe cũ', 'xe mới', 'xe điện', 'ô tô'],
    ja: ['中古車', '新車', '電気自動車', '車買取'],
    ko: ['중고차', '신차', '전기차', '자동차'],
    zh: ['二手车', '新车', '电动汽车', '汽车'],
    zh_tw: ['中古車', '新車', '電動車'],
  },
  streaming: {
    es: ['juego móvil', 'jugar gratis', 'ver películas', 'iptv'],
    pt: ['jogo mobile', 'jogar grátis', 'assistir filmes', 'iptv'],
    fr: ['jeu mobile', 'jouer gratuitement', 'regarder des films', 'iptv'],
    de: ['handyspiel', 'kostenlos spielen', 'filme streamen', 'iptv'],
    it: ['gioco mobile', 'giochi gratis', 'guardare film', 'iptv'],
    ru: ['мобильная игра', 'играть бесплатно', 'смотреть фильмы', 'iptv'],
    tr: ['mobil oyun', 'ücretsiz oyna', 'film izle', 'iptv'],
    ar: ['لعبة جوال', 'العب مجانا', 'مشاهدة افلام', 'iptv'],
    hi: ['मोबाइल गेम', 'फ्री गेम', 'फिल्में देखें'],
    id: ['game mobile', 'main gratis', 'nonton film', 'iptv'],
    th: ['เกมมือถือ', 'เล่นฟรี', 'ดูหนัง', 'iptv'],
    vi: ['game mobile', 'chơi miễn phí', 'xem phim', 'iptv'],
    ja: ['スマホゲーム', '無料ゲーム', '動画配信', 'アニメ'],
    ko: ['모바일게임', '무료게임', '드라마 다시보기', 'ott'],
    zh: ['手机游戏', '免费游戏', '在线看片', '追剧'],
    zh_tw: ['手機遊戲', '免費遊戲', '線上看'],
  },
  food: {
    es: ['comida a domicilio', 'pedir comida', 'entrega de comida', 'supermercado online', 'recetas', 'restaurante'],
    pt: ['comida a domicílio', 'pedir comida', 'entrega de comida', 'delivery de comida', 'mercado online', 'receitas'],
    fr: ['livraison de repas', 'commander à manger', 'livraison de courses', 'panier repas', 'recettes', 'restaurant'],
    de: ['essen bestellen', 'essenslieferung', 'lebensmittel liefern', 'kochbox', 'rezepte', 'lieferdienst'],
    it: ['consegna cibo', 'ordinare cibo', 'spesa online', 'cibo a domicilio', 'ricette', 'ristorante'],
    nl: ['eten bestellen', 'maaltijdbezorging', 'boodschappen bezorgen', 'maaltijdbox', 'recepten'],
    ru: ['доставка еды', 'заказать еду', 'доставка продуктов', 'продукты онлайн', 'рецепты', 'еда на дом'],
    uk: ['доставка їжі', 'замовити їжу', 'доставка продуктів', 'їжа додому'],
    pl: ['dostawa jedzenia', 'zamów jedzenie', 'zakupy online', 'catering dietetyczny', 'przepisy'],
    tr: ['yemek siparişi', 'online yemek', 'market alışverişi', 'yemek sepeti', 'tarifler'],
    ar: ['توصيل طعام', 'طلب طعام', 'توصيل بقالة', 'توصيل مطاعم', 'وصفات', 'طعام اونلاين'],
    he: ['משלוחי אוכל', 'הזמנת אוכל', 'משלוח מסעדות', 'סופר אונליין', 'מתכונים'],
    hi: ['खाना ऑर्डर', 'फूड डिलीवरी', 'ऑनलाइन खाना', 'ग्रोसरी डिलीवरी', 'रेस्तरां', 'भोजन'],
    bn: ['খাবার ডেলিভারি', 'খাবার অর্ডার', 'অনলাইন খাবার', 'গ্রোসারি ডেলিভারি', 'রেস্টুরেন্ট'],
    id: ['pesan makanan', 'antar makanan', 'belanja sayur online', 'catering diet', 'resep', 'makanan online'],
    ms: ['pesan makanan', 'penghantaran makanan', 'beli barang dapur', 'katering', 'resepi'],
    th: ['สั่งอาหาร', 'เดลิเวอรี่', 'ส่งอาหาร', 'สั่งของออนไลน์', 'ร้านอาหาร', 'สูตรอาหาร'],
    vi: ['giao đồ ăn', 'đặt đồ ăn', 'giao hàng thực phẩm', 'đi chợ online', 'nhà hàng', 'công thức nấu ăn'],
    ja: ['フードデリバリー', '出前', '宅配', 'ネットスーパー', 'ミールキット', 'レシピ'],
    ko: ['배달음식', '음식배달', '새벽배송', '밀키트', '장보기', '레시피'],
    zh: ['外卖', '订餐', '生鲜配送', '买菜', '食谱', '餐厅'],
    zh_tw: ['外送', '訂餐', '生鮮配送', '食譜', '餐廳'],
    tl: ['food delivery', 'pagkain delivery', 'grocery delivery', 'pag-order ng pagkain'],
    fa: ['سفارش غذا', 'تحویل غذا', 'خرید مواد غذایی', 'رستوران', 'دستور پخت'],
    el: ['delivery φαγητού', 'παραγγελία φαγητού', 'σούπερ μάρκετ online', 'συνταγές'],
    ro: ['livrare mâncare', 'comandă mâncare', 'cumpărături online', 'rețete', 'restaurant'],
    cs: ['rozvoz jídla', 'objednat jídlo', 'nákup potravin online', 'recepty'],
    hu: ['ételrendelés', 'ételfutár', 'online bevásárlás', 'receptek'],
    sv: ['matleverans', 'beställa mat', 'matkasse', 'handla mat online', 'recept'],
    no: ['matlevering', 'bestille mat', 'middagskasse', 'handle mat på nett'],
    da: ['madudbringning', 'bestil mad', 'måltidskasse', 'køb mad online'],
    fi: ['ruoan kotiinkuljetus', 'tilaa ruokaa', 'ruokakassi', 'ruokaostokset verkossa'],
    bg: ['доставка на храна', 'поръчай храна', 'онлайн пазаруване', 'рецепти'],
    sw: ['uwasilishaji chakula', 'agiza chakula', 'ununuzi wa mboga', 'mapishi'],
  },
  credit: {
    es: ['tarjeta de crédito', 'reparar crédito', 'consolidación de deudas', 'informe de crédito'],
    pt: ['cartão de crédito', 'limpar nome', 'consolidação de dívidas', 'score de crédito'],
    fr: ['carte de crédit', 'rachat de crédit', 'surendettement', 'carte bancaire'],
    de: ['kreditkarte', 'schufa', 'schuldnerberatung', 'umschuldung'],
    it: ['carta di credito', 'cessione del quinto', 'consolidamento debiti'],
    ru: ['кредитная карта', 'кредитная история', 'реструктуризация долга'],
    tr: ['kredi kartı', 'kredi notu', 'borç yapılandırma'],
    ar: ['بطاقة ائتمان', 'تسوية الديون', 'التقرير الائتماني'],
    hi: ['क्रेडिट कार्ड', 'क्रेडिट स्कोर', 'कर्ज राहत'],
    id: ['kartu kredit', 'skor kredit', 'keringanan utang', 'paylater'],
    th: ['บัตรเครดิต', 'รวมหนี้', 'ปิดหนี้'],
    vi: ['thẻ tín dụng', 'điểm tín dụng', 'trả góp'],
    ja: ['クレジットカード', '債務整理', '借金相談', 'おまとめ'],
    ko: ['신용카드', '신용점수', '채무통합', '카드론'],
    zh: ['信用卡', '信用评分', '债务重组', '分期付款'],
    zh_tw: ['信用卡', '債務整合', '分期付款'],
  },
  beauty: {
    es: ['cuidado de la piel', 'antiedad', 'tratamiento acné', 'depilación láser', 'cirugía estética'],
    pt: ['cuidados com a pele', 'antienvelhecimento', 'tratamento de acne', 'depilação a laser', 'harmonização facial'],
    fr: ['soin de la peau', 'anti-âge', 'traitement acné', 'épilation laser', 'chirurgie esthétique'],
    de: ['hautpflege', 'anti aging', 'aknebehandlung', 'laser haarentfernung', 'schönheitschirurgie'],
    it: ['cura della pelle', 'antietà', 'trattamento acne', 'epilazione laser', 'chirurgia estetica'],
    ru: ['уход за кожей', 'антивозрастной', 'лечение акне', 'лазерная эпиляция', 'косметология'],
    tr: ['cilt bakımı', 'yaşlanma karşıtı', 'akne tedavisi', 'lazer epilasyon', 'estetik'],
    ar: ['العناية بالبشرة', 'مكافحة الشيخوخة', 'علاج حب الشباب', 'ليزر', 'تجميل'],
    hi: ['स्किन केयर', 'एंटी एजिंग', 'मुंहासे का इलाज', 'लेजर हेयर रिमूवल'],
    id: ['perawatan kulit', 'anti penuaan', 'perawatan jerawat', 'laser', 'klinik kecantikan'],
    th: ['ดูแลผิว', 'แอนตี้เอจ', 'รักษาสิว', 'เลเซอร์', 'คลินิกความงาม'],
    vi: ['chăm sóc da', 'chống lão hóa', 'trị mụn', 'triệt lông', 'thẩm mỹ viện'],
    ja: ['スキンケア', 'アンチエイジング', 'ニキビ治療', '医療脱毛', '美容整形'],
    ko: ['스킨케어', '안티에이징', '여드름 치료', '제모', '성형외과'],
    zh: ['护肤', '抗衰老', '祛痘', '激光脱毛', '医美'],
    zh_tw: ['護膚', '抗老', '除痘', '雷射除毛', '醫美'],
  },
  legal: {
    es: ['abogado', 'abogado de accidentes', 'reclamar indemnización', 'abogado de divorcio'],
    pt: ['advogado', 'advogado de acidentes', 'indenização', 'advogado trabalhista'],
    fr: ['avocat', 'avocat accident', 'indemnisation', 'avocat divorce'],
    de: ['anwalt', 'anwalt verkehrsunfall', 'schmerzensgeld', 'scheidungsanwalt'],
    it: ['avvocato', 'risarcimento danni', 'avvocato divorzio', 'incidente stradale'],
    ru: ['адвокат', 'юрист', 'компенсация', 'автоюрист'],
    tr: ['avukat', 'tazminat davası', 'boşanma avukatı', 'iş avukatı'],
    ar: ['محامي', 'تعويضات', 'محامي طلاق', 'قضية'],
    hi: ['वकील', 'दुर्घटना मुआवजा', 'तलाक वकील', 'कानूनी सलाह'],
    id: ['pengacara', 'ganti rugi', 'pengacara perceraian', 'bantuan hukum'],
    th: ['ทนายความ', 'เรียกค่าเสียหาย', 'ทนายหย่า', 'ปรึกษากฎหมาย'],
    vi: ['luật sư', 'bồi thường', 'luật sư ly hôn', 'tư vấn pháp luật'],
    ja: ['弁護士', '交通事故 慰謝料', '離婚弁護士', '過払い金'],
    ko: ['변호사', '교통사고 합의금', '이혼 변호사', '법률 상담'],
    zh: ['律师', '事故赔偿', '离婚律师', '法律咨询'],
    zh_tw: ['律師', '事故賠償', '離婚律師', '法律諮詢'],
  },
  utilities: {
    es: ['tarifa móvil', 'internet fibra', 'compañía de luz', 'comparador de tarifas', 'esim'],
    pt: ['plano de celular', 'internet fibra', 'conta de luz', 'energia', 'esim'],
    fr: ['forfait mobile', 'box internet', 'fournisseur d électricité', 'fibre', 'esim'],
    de: ['handytarif', 'dsl anbieter', 'stromanbieter', 'gasanbieter', 'esim'],
    it: ['offerte mobile', 'fibra ottica', 'fornitore luce e gas', 'esim'],
    ru: ['тариф связи', 'домашний интернет', 'электроэнергия', 'esim'],
    tr: ['mobil tarife', 'fiber internet', 'elektrik aboneliği', 'esim'],
    ar: ['باقة موبايل', 'انترنت فايبر', 'شركة كهرباء', 'esim'],
    hi: ['मोबाइल प्लान', 'ब्रॉडबैंड', 'बिजली कनेक्शन', 'esim'],
    id: ['paket data', 'internet rumah', 'listrik', 'esim'],
    th: ['แพ็กเกจมือถือ', 'เน็ตบ้าน', 'ค่าไฟ', 'esim'],
    vi: ['gói cước di động', 'internet cáp quang', 'điện lực', 'esim'],
    ja: ['格安sim', '光回線', '電気料金', 'esim'],
    ko: ['알뜰폰', '인터넷 가입', '전기요금', 'esim'],
    zh: ['手机套餐', '宽带办理', '电费', 'esim'],
    zh_tw: ['手機資費', '光纖網路', '電費', 'esim'],
  },
};

// ───────────────────────────────────────────────────────────────────────────
// CTA_MULTILINGUAL: cross-vertical intent / call-to-action words. These recur
// in advertiser display names and ad-account labels worldwide. Tagged
// vertical='cta' so a vertical-filtered job can exclude them.
// ───────────────────────────────────────────────────────────────────────────

const CTA_MULTILINGUAL: Partial<Record<string, string[]>> = {
  en: ['download', 'download now', 'install now', 'play now', 'sign up', 'register', 'buy now', 'get offer', 'free', 'bonus', 'get started', 'apply now', 'claim now', 'join now', 'try free'],
  es: ['descargar', 'jugar ahora', 'regístrate', 'comprar ahora', 'gratis', 'bono', 'oferta', 'solicita ya'],
  pt: ['baixar', 'jogar agora', 'cadastre-se', 'comprar agora', 'grátis', 'bônus', 'oferta', 'peça já'],
  fr: ['télécharger', 'jouer maintenant', "s'inscrire", 'acheter', 'gratuit', 'bonus', 'offre'],
  de: ['herunterladen', 'jetzt spielen', 'registrieren', 'jetzt kaufen', 'gratis', 'bonus', 'angebot'],
  it: ['scarica', 'gioca ora', 'registrati', 'compra ora', 'gratis', 'bonus', 'offerta'],
  nl: ['downloaden', 'speel nu', 'aanmelden', 'nu kopen', 'gratis', 'bonus'],
  ru: ['скачать', 'играть', 'регистрация', 'купить', 'бесплатно', 'бонус', 'акция'],
  uk: ['завантажити', 'грати', 'реєстрація', 'купити', 'безкоштовно', 'бонус'],
  pl: ['pobierz', 'graj teraz', 'zarejestruj się', 'kup teraz', 'za darmo', 'bonus'],
  tr: ['indir', 'hemen oyna', 'kayıt ol', 'satın al', 'ücretsiz', 'bonus'],
  ar: ['تحميل', 'العب الآن', 'سجل الآن', 'اشتري الآن', 'مجانا', 'مكافأة', 'عرض'],
  he: ['הורדה', 'שחקו עכשיו', 'הרשמה', 'קנה עכשיו', 'חינם', 'בונוס'],
  hi: ['डाउनलोड', 'अभी खेलें', 'साइन अप', 'अभी खरीदें', 'फ्री', 'बोनस'],
  id: ['unduh', 'main sekarang', 'daftar', 'beli sekarang', 'gratis', 'bonus', 'promo'],
  ms: ['muat turun', 'main sekarang', 'daftar', 'beli sekarang', 'percuma', 'bonus'],
  th: ['ดาวน์โหลด', 'เล่นเลย', 'สมัคร', 'ซื้อเลย', 'ฟรี', 'โบนัส'],
  vi: ['tải về', 'chơi ngay', 'đăng ký', 'mua ngay', 'miễn phí', 'khuyến mãi'],
  ja: ['ダウンロード', '今すぐプレイ', '登録', '購入', '無料', 'ボーナス', '公式'],
  ko: ['다운로드', '지금 플레이', '가입', '구매', '무료', '보너스', '공식'],
  zh: ['下载', '立即游戏', '注册', '立即购买', '免费', '优惠', '官网'],
  zh_tw: ['下載', '立即遊戲', '註冊', '立即購買', '免費', '優惠', '官網'],
  tl: ['i-download', 'maglaro na', 'mag-sign up', 'bumili na', 'libre', 'bonus'],
  fa: ['دانلود', 'ثبت نام', 'خرید', 'رایگان', 'بونوس', 'همین حالا'],
  el: ['κατέβασε', 'παίξε τώρα', 'εγγραφή', 'αγόρασε', 'δωρεάν', 'μπόνους'],
  ro: ['descarcă', 'joacă acum', 'înregistrează-te', 'cumpără acum', 'gratis', 'bonus'],
  cs: ['stáhnout', 'hraj teď', 'registrace', 'koupit', 'zdarma', 'bonus'],
  hu: ['letöltés', 'játssz most', 'regisztráció', 'vásárolj', 'ingyen', 'bónusz'],
  sv: ['ladda ner', 'spela nu', 'registrera', 'köp nu', 'gratis', 'bonus'],
  no: ['last ned', 'spill nå', 'registrer', 'kjøp nå', 'gratis', 'bonus'],
  da: ['download', 'spil nu', 'tilmeld', 'køb nu', 'gratis', 'bonus'],
  fi: ['lataa', 'pelaa nyt', 'rekisteröidy', 'osta nyt', 'ilmainen', 'bonus'],
  bg: ['изтегли', 'играй сега', 'регистрация', 'купи сега', 'безплатно', 'бонус'],
  sw: ['pakua', 'cheza sasa', 'jisajili', 'nunua sasa', 'bure', 'bonasi'],
};

// ───────────────────────────────────────────────────────────────────────────
// Flatten → dedupe → index.
// ───────────────────────────────────────────────────────────────────────────

function normalize(kw: string): string {
  return kw.replace(/\s+/g, ' ').trim();
}

function buildEntries(): KeywordEntry[] {
  const out: KeywordEntry[] = [];
  const seen = new Set<string>(); // case-insensitive dedupe key

  const push = (rawKw: string, vertical: string, lang: string) => {
    const kw = normalize(rawKw);
    if (!kw) return;
    const key = kw.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kw, vertical, lang });
  };

  // 1. English vertical seed lists.
  for (const v of VERTICAL_DEFS) {
    for (const kw of v.en) push(kw, v.meta.id, 'en');
  }

  // 2. Per-vertical multilingual translations.
  for (const [vertical, langMap] of Object.entries(CORE_MULTILINGUAL)) {
    if (!langMap) continue;
    for (const [lang, terms] of Object.entries(langMap)) {
      if (!terms) continue;
      for (const kw of terms) push(kw, vertical, lang);
    }
  }

  // 3. Cross-vertical CTA / intent words.
  for (const [lang, terms] of Object.entries(CTA_MULTILINGUAL)) {
    if (!terms) continue;
    for (const kw of terms) push(kw, 'cta', lang);
  }

  return out;
}

export const ALL_KEYWORD_ENTRIES: KeywordEntry[] = buildEntries();

/** Flat, deduped keyword list — the full exemplar bank. */
export const GOOGLE_ADS_KEYWORDS: string[] = ALL_KEYWORD_ENTRIES.map((e) => e.kw);

// ───────────────────────────────────────────────────────────────────────────
// Sampling.
// ───────────────────────────────────────────────────────────────────────────

export interface KeywordSelection {
  /** Vertical ids to include. Empty/omitted = all. 'cta' is always allowed only when no vertical filter is set. */
  verticals?: string[] | null;
  /** Language codes to include. Empty/omitted = all languages. */
  languages?: string[] | null;
  /** Max number of keywords to return. <=0 or omitted = all matched. */
  limit?: number | null;
}

/**
 * Interleave a list of entries by vertical then language so a bounded sample
 * spreads across the whole bank instead of taking the first N (which would be
 * all-English-igaming). Deterministic: depends only on input order, so a job's
 * keyword set is reproducible across replays.
 */
function interleave(entries: KeywordEntry[]): KeywordEntry[] {
  const byVertical = new Map<string, KeywordEntry[]>();
  for (const e of entries) {
    const arr = byVertical.get(e.vertical) ?? [];
    arr.push(e);
    byVertical.set(e.vertical, arr);
  }
  // Within each vertical, interleave by language too.
  const verticalQueues: KeywordEntry[][] = [];
  for (const arr of byVertical.values()) {
    const byLang = new Map<string, KeywordEntry[]>();
    for (const e of arr) {
      const la = byLang.get(e.lang) ?? [];
      la.push(e);
      byLang.set(e.lang, la);
    }
    const langQueues = [...byLang.values()];
    const merged: KeywordEntry[] = [];
    let idx = 0;
    let remaining = arr.length;
    while (remaining > 0) {
      const q = langQueues[idx % langQueues.length];
      if (q.length > 0) {
        merged.push(q.shift()!);
        remaining--;
      }
      idx++;
      // Guard against infinite loop if all queues drained.
      if (idx > arr.length * langQueues.length + langQueues.length) break;
    }
    verticalQueues.push(merged);
  }

  // Round-robin across verticals.
  const result: KeywordEntry[] = [];
  let idx = 0;
  let total = entries.length;
  while (total > 0 && verticalQueues.length > 0) {
    const q = verticalQueues[idx % verticalQueues.length];
    if (q.length > 0) {
      result.push(q.shift()!);
      total--;
    }
    idx++;
    if (idx > entries.length * verticalQueues.length + verticalQueues.length) break;
  }
  return result;
}

/**
 * Select a well-spread, bounded keyword sample for a job.
 * - verticals filter (empty = all)
 * - languages filter (empty = all)
 * - limit (<=0 = all matched)
 */
export function keywordsForJob(sel: KeywordSelection = {}): string[] {
  const vset = sel.verticals && sel.verticals.length > 0 ? new Set(sel.verticals) : null;
  const lset = sel.languages && sel.languages.length > 0 ? new Set(sel.languages) : null;

  let filtered = ALL_KEYWORD_ENTRIES.filter((e) => {
    // When a vertical filter is applied, drop cross-vertical CTA words —
    // the operator asked for specific verticals.
    if (vset) {
      if (e.vertical === 'cta') return false;
      if (!vset.has(e.vertical)) return false;
    }
    if (lset && !lset.has(e.lang)) return false;
    return true;
  });

  const spread = interleave(filtered);
  const limit = sel.limit && sel.limit > 0 ? sel.limit : spread.length;
  const out = spread.slice(0, limit).map((e) => e.kw);
  return out;
}

/** Coverage summary for logs / diagnostics. */
export function keywordStats(): {
  total: number;
  byLanguage: Record<string, number>;
  byVertical: Record<string, number>;
  languages: number;
  verticals: number;
} {
  const byLanguage: Record<string, number> = {};
  const byVertical: Record<string, number> = {};
  for (const e of ALL_KEYWORD_ENTRIES) {
    byLanguage[e.lang] = (byLanguage[e.lang] || 0) + 1;
    byVertical[e.vertical] = (byVertical[e.vertical] || 0) + 1;
  }
  return {
    total: ALL_KEYWORD_ENTRIES.length,
    byLanguage,
    byVertical,
    languages: Object.keys(byLanguage).length,
    verticals: Object.keys(byVertical).length,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Offline unit tests (no network). Run via `node dist/googleAdsKeywords.js`
// or `tsx src/googleAdsKeywords.ts`.
// ───────────────────────────────────────────────────────────────────────────

export function runGoogleAdsKeywordTests(): { passed: number; failed: number; failures: string[] } {
  let passed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, desc: string) => {
    if (cond) passed++;
    else failures.push(`FAIL: ${desc}`);
  };

  const stats = keywordStats();

  // Scale: the bank must be genuinely large and multilingual.
  check(stats.total >= 1200, `bank is humongous (>=1200): got ${stats.total}`);
  check(stats.languages >= 30, `covers >=30 languages: got ${stats.languages}`);
  check(stats.verticals >= 15, `covers >=15 verticals(+cta): got ${stats.verticals}`);

  // No empties, all trimmed.
  check(GOOGLE_ADS_KEYWORDS.every((k) => k.length > 0), 'no empty keywords');
  check(GOOGLE_ADS_KEYWORDS.every((k) => k === k.trim()), 'all keywords trimmed');

  // Case-insensitive dedupe holds.
  const lowered = GOOGLE_ADS_KEYWORDS.map((k) => k.toLowerCase());
  check(new Set(lowered).size === lowered.length, 'no case-insensitive duplicates');

  // Every entry references a known vertical + language.
  check(ALL_KEYWORD_ENTRIES.every((e) => KNOWN_VERTICAL_IDS.has(e.vertical)), 'every entry has a known vertical id');
  check(ALL_KEYWORD_ENTRIES.every((e) => KNOWN_LANG_CODES.has(e.lang)), 'every entry has a known language code');

  // Multi-script coverage — the point of "all languages".
  const joined = GOOGLE_ADS_KEYWORDS.join('\n');
  check(/[Ѐ-ӿ]/.test(joined), 'contains Cyrillic script');
  check(/[぀-ヿ]/.test(joined), 'contains Japanese kana');
  check(/[一-鿿]/.test(joined), 'contains CJK ideographs');
  check(/[가-힯]/.test(joined), 'contains Korean Hangul');
  check(/[؀-ۿ]/.test(joined), 'contains Arabic script');
  check(/[֐-׿]/.test(joined), 'contains Hebrew script');
  check(/[ऀ-ॿ]/.test(joined), 'contains Devanagari (Hindi)');
  check(/[฀-๿]/.test(joined), 'contains Thai script');

  // Sampling: limit is respected.
  const s40 = keywordsForJob({ limit: 40 });
  check(s40.length === 40, `limit respected: got ${s40.length}`);
  check(new Set(s40.map((k) => k.toLowerCase())).size === s40.length, 'sample has no dupes');

  // Sampling spreads across verticals (interleave), not first-N-of-one-vertical.
  const sampleVerticals = new Set(
    s40.map((kw) => ALL_KEYWORD_ENTRIES.find((e) => e.kw === kw)?.vertical),
  );
  check(sampleVerticals.size >= 6, `40-sample spans >=6 verticals: got ${sampleVerticals.size}`);

  // Vertical filter excludes other verticals and CTA words.
  const onlyLoans = keywordsForJob({ verticals: ['loans'], limit: 30 });
  const loanEntryOk = onlyLoans.every((kw) => ALL_KEYWORD_ENTRIES.find((e) => e.kw === kw)?.vertical === 'loans');
  check(loanEntryOk, 'vertical filter yields only that vertical (no cta/others)');
  check(onlyLoans.length > 0, 'vertical filter yields some keywords');

  // Language filter yields only that language.
  const onlyJa = keywordsForJob({ languages: ['ja'], limit: 30 });
  const jaOk = onlyJa.every((kw) => ALL_KEYWORD_ENTRIES.find((e) => e.kw === kw)?.lang === 'ja');
  check(jaOk && onlyJa.length > 0, 'language filter yields only that language');

  // Combined filter.
  const casinoRu = keywordsForJob({ verticals: ['igaming'], languages: ['ru'], limit: 10 });
  check(
    casinoRu.length > 0 &&
      casinoRu.every((kw) => {
        const e = ALL_KEYWORD_ENTRIES.find((x) => x.kw === kw);
        return e?.vertical === 'igaming' && e?.lang === 'ru';
      }),
    'combined vertical+language filter works',
  );

  // Determinism: same selection twice → identical output.
  const a = keywordsForJob({ limit: 25 });
  const b = keywordsForJob({ limit: 25 });
  check(JSON.stringify(a) === JSON.stringify(b), 'sampling is deterministic');

  // Metadata sanity.
  check(GOOGLE_ADS_VERTICALS.length >= 15, 'vertical metadata present');
  check(GOOGLE_ADS_LANGUAGES.length >= 30, 'language metadata present');
  check(new Set(GOOGLE_ADS_VERTICALS.map((v) => v.id)).size === GOOGLE_ADS_VERTICALS.length, 'vertical ids unique');
  check(new Set(GOOGLE_ADS_LANGUAGES.map((l) => l.code)).size === GOOGLE_ADS_LANGUAGES.length, 'language codes unique');

  return { passed, failed: failures.length, failures };
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('googleAdsKeywords.js') || process.argv[1].endsWith('googleAdsKeywords.ts'));
if (isMain) {
  const stats = keywordStats();
  console.log(`googleAdsKeywords: ${stats.total} keywords across ${stats.languages} languages, ${stats.verticals} verticals`);
  const { passed, failed, failures } = runGoogleAdsKeywordTests();
  console.log(`googleAdsKeywords tests: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  ' + f);
  process.exit(failed === 0 ? 0 : 1);
}
