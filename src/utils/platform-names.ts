// Spec v1.0 (section 2.1): platforms go out as meta, google, tiktok, taboola.
// client_ad_accounts stores the canonicalizePlatform() forms (facebook-ads,
// google-ads, tik-tok), so names are mapped at the API boundary and nothing in
// the database changes. Input of any alias is accepted by normalisePlatform().
const TO_SPEC: Record<string, string> = {
  'facebook-ads': 'meta',
  'google-ads': 'google',
  'tik-tok': 'tiktok',
  taboola: 'taboola',
  'bing-ads': 'bing',
};

export function toSpecPlatform(stored: string): string {
  return TO_SPEC[stored] ?? stored;
}
