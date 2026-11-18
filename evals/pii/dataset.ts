import type { PiiType } from "@lexguard/guardrails";

// Hand-labelled, synthetic contract snippets for measuring PII redaction.
// All values are fictional or published test values: standard test card numbers, IBAN
// examples from the IBAN registry documentation, 555 / Ofcom drama phone ranges.
//
// Each case lists every piece of PII a careful human reviewer would redact, including
// kinds we know we cannot detect yet (NAME, unusual formats). The eval then shows
// honestly what we catch and what we miss. Do not edit labels to make scores go up.

export type LabelType = PiiType | "NAME";

export interface Label {
  type: LabelType;
  value: string;
}

export type Category = "positive" | "hard_positive" | "negative" | "mixed";

export interface PiiCase {
  id: string;
  category: Category;
  text: string;
  expected: Label[];
  note?: string;
}

export const DATASET_VERSION = "pii-v1";

export const piiCases: PiiCase[] = [
  // --- Emails ---
  {
    id: "email-basic",
    category: "positive",
    text: "All notices shall be sent to legal@northwind-traders.com.",
    expected: [{ type: "EMAIL", value: "legal@northwind-traders.com" }],
  },
  {
    id: "email-subdomain-tag",
    category: "positive",
    text: "Invoices: billing+contracts@finance.acme.co.uk (Attn: AP).",
    expected: [{ type: "EMAIL", value: "billing+contracts@finance.acme.co.uk" }],
  },
  {
    id: "email-two",
    category: "positive",
    text: "Contacts: Jane.Doe@Contoso.com and ops@contoso.com.",
    expected: [
      { type: "EMAIL", value: "Jane.Doe@Contoso.com" },
      { type: "EMAIL", value: "ops@contoso.com" },
    ],
  },
  {
    id: "email-obfuscated",
    category: "hard_positive",
    text: "Questions may be addressed to privacy (at) fabrikam (dot) com.",
    expected: [{ type: "EMAIL", value: "privacy (at) fabrikam (dot) com" }],
    note: "Obfuscated address; regex is expected to miss it.",
  },

  // --- Phones ---
  {
    id: "phone-uk-intl",
    category: "positive",
    text: "Tel: +44 20 7946 0958, Monday to Friday.",
    expected: [{ type: "PHONE", value: "+44 20 7946 0958" }],
  },
  {
    id: "phone-us-intl",
    category: "positive",
    text: "Support line +1 (415) 555-0132 is staffed 24/7.",
    expected: [{ type: "PHONE", value: "+1 (415) 555-0132" }],
  },
  {
    id: "phone-egypt-intl",
    category: "positive",
    text: "Cairo office: +20 2 2795 1234.",
    expected: [{ type: "PHONE", value: "+20 2 2795 1234" }],
  },
  {
    id: "phone-uk-national",
    category: "positive",
    text: "Call 020 7946 0958 to report an incident.",
    expected: [{ type: "PHONE", value: "020 7946 0958" }],
  },
  {
    id: "phone-us-national",
    category: "hard_positive",
    text: "Escalations: (415) 555-0199.",
    expected: [{ type: "PHONE", value: "(415) 555-0199" }],
    note: "No + or leading 0; the narrow phone pattern is expected to miss it.",
  },
  {
    id: "phone-dots",
    category: "positive",
    text: "Fax +33.1.23.45.67.89 for urgent matters.",
    expected: [{ type: "PHONE", value: "+33.1.23.45.67.89" }],
  },

  // --- IBANs ---
  {
    id: "iban-gb-spaced",
    category: "positive",
    text: "Payment to GB82 WEST 1234 5698 7654 32 within 30 days.",
    expected: [{ type: "IBAN", value: "GB82 WEST 1234 5698 7654 32" }],
  },
  {
    id: "iban-de-compact",
    category: "positive",
    text: "Bank account (IBAN): DE89370400440532013000.",
    expected: [{ type: "IBAN", value: "DE89370400440532013000" }],
  },
  {
    id: "iban-fr-letters",
    category: "positive",
    text: "IBAN FR14 2004 1010 0505 0001 3M02 606 Banque Exemple.",
    expected: [{ type: "IBAN", value: "FR14 2004 1010 0505 0001 3M02 606" }],
  },
  {
    id: "iban-eg",
    category: "positive",
    text: "Transfers in EGP to EG380019000500000000263180002 only.",
    expected: [{ type: "IBAN", value: "EG380019000500000000263180002" }],
  },
  {
    id: "iban-nl-be",
    category: "positive",
    text: "Accounts NL91 ABNA 0417 1643 00 and BE68 5390 0754 7034.",
    expected: [
      { type: "IBAN", value: "NL91 ABNA 0417 1643 00" },
      { type: "IBAN", value: "BE68 5390 0754 7034" },
    ],
  },

  // --- Cards ---
  {
    id: "card-visa",
    category: "positive",
    text: "Card on file: 4111 1111 1111 1111 (exp. 12/29).",
    expected: [{ type: "CARD", value: "4111 1111 1111 1111" }],
  },
  {
    id: "card-mc-dashes",
    category: "positive",
    text: "Corporate card 5555-5555-5555-4444 is authorised.",
    expected: [{ type: "CARD", value: "5555-5555-5555-4444" }],
  },
  {
    id: "card-amex",
    category: "positive",
    text: "Amex 378282246310005 for travel expenses.",
    expected: [{ type: "CARD", value: "378282246310005" }],
  },

  // --- Names (not supported by regex) ---
  {
    id: "name-signatory",
    category: "hard_positive",
    text: "Signed for the Supplier by John Smith, Managing Director.",
    expected: [{ type: "NAME", value: "John Smith" }],
    note: "Names need NER; regex is expected to miss them.",
  },
  {
    id: "name-arabic",
    category: "hard_positive",
    text: "The Data Protection Officer is Fatma El-Sayed.",
    expected: [{ type: "NAME", value: "Fatma El-Sayed" }],
  },

  // --- Negatives: look numeric or structured, contain no PII ---
  {
    id: "neg-section-numbers",
    category: "negative",
    text: "Subject to Sections 12.3.4 and 14.1.2.7, the cap applies.",
    expected: [],
  },
  {
    id: "neg-amounts",
    category: "negative",
    text: "Fees of EUR 1,250,000.00 and USD 15000000 are payable.",
    expected: [],
  },
  {
    id: "neg-dates",
    category: "negative",
    text: "Effective 2026-11-10 until 31/12/2029, renewing on 01.01.2030.",
    expected: [],
  },
  {
    id: "neg-bad-checksum-card",
    category: "negative",
    text: "Purchase order 4111111111111112 references the quote.",
    expected: [],
    note: "Card-shaped but fails Luhn.",
  },
  {
    id: "neg-bad-checksum-iban",
    category: "negative",
    text: "Reference GB82 WEST 1234 5698 7654 33 is a typo in the draft.",
    expected: [],
    note: "IBAN-shaped but fails mod-97.",
  },
  {
    id: "neg-company-number",
    category: "negative",
    text: "Registered in England, company number 01234567.",
    expected: [],
    note: "Leading-zero registration number; may look like a national phone number.",
  },
  {
    id: "neg-registration-id",
    category: "negative",
    text: "Commercial register entry 0123456789 (Cairo).",
    expected: [],
  },
  {
    id: "neg-version-and-ip-like",
    category: "negative",
    text: "Schedule 3, version 2.10.4.1, applies to all Services.",
    expected: [],
  },
  {
    id: "neg-plain-clause",
    category: "negative",
    text: "Either party may terminate this Agreement on ninety (90) days' written notice.",
    expected: [],
  },

  // --- Mixed: realistic clauses with several items ---
  {
    id: "mixed-notice-clause",
    category: "mixed",
    text:
      "15.2 Notices. Notices to the Customer shall be sent to Maria Garcia at " +
      "m.garcia@woodgrove.example or +34 91 123 45 67.",
    expected: [
      { type: "NAME", value: "Maria Garcia" },
      { type: "EMAIL", value: "m.garcia@woodgrove.example" },
      { type: "PHONE", value: "+34 91 123 45 67" },
    ],
  },
  {
    id: "mixed-payment-clause",
    category: "mixed",
    text:
      "7.1 Payment. The Customer shall pay EUR 48,000.00 by 2027-01-15 to " +
      "ES91 2100 0418 4502 0005 1332, quoting PO 77-2031.",
    expected: [{ type: "IBAN", value: "ES91 2100 0418 4502 0005 1332" }],
  },
  {
    id: "mixed-dpa-annex",
    category: "mixed",
    text:
      "Annex 2: controller contact dpo@tailspin.example, tel 0161 496 0000; " +
      "processor bank CH93 0076 2011 6238 5295 7.",
    expected: [
      { type: "EMAIL", value: "dpo@tailspin.example" },
      { type: "PHONE", value: "0161 496 0000" },
      { type: "IBAN", value: "CH93 0076 2011 6238 5295 7" },
    ],
  },
  {
    id: "mixed-card-and-amount",
    category: "mixed",
    text: "Charge USD 1,200 to card 6011 1111 1111 1117 on 2026-12-01 (Clause 9.4).",
    expected: [{ type: "CARD", value: "6011 1111 1111 1117" }],
  },
];
