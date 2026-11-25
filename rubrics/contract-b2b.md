---
require_signoff: true
high_blocks_always: true
effort: high
confidential: true
report_notice: "Reviewers are AI agents, not lawyers. This review is not legal advice. A person must sign off before the contract is used."
---
# B2B contract

## Purpose

Check a business-to-business services contract before it is sent or signed, so that it says what both parties agreed, has no gaps that cost money or create legal risk, and is consistent with itself and with the accepted proposal.

## What to check

- Parties: full legal names, addresses and registration numbers are present and match across the contract and annexes. Who signs, and in what role.
- Scope and deliverables: what is delivered, what is not, and how acceptance works.
- Price: one amount, the same in every clause and annex. Currency and VAT treatment are stated. Totals add up.
- Payment terms: invoice schedule, due dates, and late payment interest.
- Term and termination: start, end, renewal, notice periods, and what happens to work, payments and data on termination.
- Liability: a cap, and the exclusions (indirect damages, lost profit). Unlimited liability for the supplier is a high impact finding.
- IP ownership and licence: who owns what is built, and what each party may use afterwards.
- Confidentiality: what is covered, for how long, and the exceptions.
- Data protection: if personal data is processed (for example customer records), a data processing agreement (DPA) is needed. Missing DPA is a high impact finding.
- Governing law and jurisdiction: stated, and sensible for both parties. Missing governing law is a high impact finding.
- Defined terms: used consistently, and every capitalised term is defined.
- Numbers and dates: consistent across clauses and annexes.
- Related proposal: if the accepted proposal is given, any mismatch in price, scope or timeline is a high impact finding.

## Assumptions to state

The author should state the jurisdiction and the language of the contract (for example Slovenian law, Slovenian text). If they are not stated, raise this as a finding with assumption_challenge set to true.

## Out of scope

- Drafting style and word choice, unless it changes meaning.
- Tax advice beyond whether VAT treatment is stated.

## Impact anchors

- critical: wrong price, wrong party, a legal commitment the author did not intend, leaked confidential data.
- high: unlimited liability, missing governing law, missing DPA when personal data is processed, a mismatch with the accepted proposal, numbers or dates that contradict each other.
- medium: unclear acceptance, missing late payment interest, an undefined term.
- low: style.
