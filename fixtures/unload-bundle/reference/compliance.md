---
type: "Reference"
title: "Compliance & Governance"
description: "GDPR/CCPA posture, PII inventory, retention, deletion, access control."
tags: ["reference","compliance","privacy"]
---
# Compliance & Data Governance Reference

This document describes the compliance posture of the data platform, covering GDPR, CCPA, and internal governance.

## 1. Legal basis for processing

- **Legitimate interest**: analytics on aggregated, pseudonymized data.
- **Contract**: processing necessary to provide the service.
- **Consent**: marketing and personalization, captured at signup.

## 2. Data classification

- **Public**: product names, published benchmarks.
- **Internal**: most operational data.
- **Confidential**: customer PII, revenue breakdowns, employee data.
- **Restricted**: payment card data, legal documents.

## 3. PII inventory

The warehouse stores these personal data categories:

- Customer identifiers: email, phone, postal address.
- Behavioral: session events, page views, clicks.
- Financial: payment amounts, subscription status (no raw card numbers).

Raw card numbers are never stored in the warehouse. PCI-scoped systems handle card data separately.

## 4. Retention policy

- Events: 24 months, then aggregated and purged.
- Orders: 10 years (tax compliance).
- Customer records: deleted on account deletion, or 12 months after inactivity.
- Backups: 30 days hot, 1 year cold.

## 5. Deletion requests (GDPR Art. 17)

The deletion pipeline runs nightly:

1. Request received via the privacy portal.
2. Verified within 1 business day.
3. Hard delete from bronze/silver within 30 days.
4. Aggregated metrics are not retroactively re-computed (pseudonymized).

## 6. Access control

- Role-based access: analyst, engineer, admin, compliance.
- Every query is logged with the requester identity.
- Restricted datasets require a two-person approval flow.

## 7. Privacy impact assessments

Any new collection of personal data requires a PIA before launch. The privacy team reviews within 10 business days.

## 8. Incident handling

Security or privacy incidents follow the runbook: containment, assessment, notification to authorities within 72 hours where required.

## 9. Monitoring & audit

- Access logs retained 18 months.
- Quarterly access reviews.
- Annual third-party audit for SOC 2.

## 10. Contacts

- Data Protection Officer: dpo@example.com
- Security: security@example.com
- Privacy requests: privacy@example.com

## Cross-references

See [[reference/sla_policy]], [[reference/ownership_matrix]], [[glossary/net_revenue]].


## 11. Data subject rights

### 11.1 Access (Art. 15)

Customers can request a copy of their personal data via the privacy portal. The platform responds within 30 days, providing a machine-readable export.

### 11.2 Rectification (Art. 16)

Inaccurate personal data can be corrected through the account settings or by contacting support. Corrections propagate to the warehouse within 24 hours.

### 11.3 Erasure (Art. 17)

See section 5. The nightly deletion pipeline executes verified requests. Records flagged for deletion are excluded from all new queries within 24 hours.

### 11.4 Portability (Art. 20)

Exports are provided in CSV and JSON. The export contains order history, account profile, and usage data, excluding derived metrics.

### 11.5 Objection (Art. 21)

Customers may object to processing for legitimate interests. The platform suspends the relevant processing within 30 days unless a compelling legal basis overrides it.

## 12. Sub-processors

The platform uses the following sub-processors, each covered by a data processing agreement:

| Sub-processor | Purpose | Location |
|---|---|---|
| Cloud Infrastructure Co. | Hosting | us-central1, eu-west1 |
| Analytics Services | Warehouse processing | us-central1 |
| Email Delivery Inc. | Transactional email | us-west1 |
| Payments Processing Ltd | Payment orchestration | eu-west1 |

New sub-processors are announced 30 days before onboarding via the status page and email.

## 13. Cross-border transfers

- EU/EEA data is processed in eu-west1 by default.
- US transfers rely on the adequacy decision and standard contractual clauses.
- A transfer impact assessment is performed before enabling any new region.
- No data is sold or shared for advertising purposes.

## 14. Breach notification

In the event of a personal data breach:

1. **72 hours**: notify the supervisory authority where required (GDPR Art. 33).
2. **Without undue delay**: notify affected data subjects when the risk is high (Art. 34).
3. **24 hours**: internal incident record with root cause and remediation.
4. **Quarterly**: summarize all breaches (including near-misses) in the security review.

## 15. Employee access

- Access to production data requires a business justification and manager approval.
- Access is provisioned through the role catalog; privileges are reviewed quarterly.
- Queries on confidential data are double-audited by the compliance team.
- Departing employees have access revoked within 24 hours of termination.

## 16. AI and ML governance

- Models trained on customer data use pseudonymized features.
- Training datasets are catalogued with retention windows.
- Model outputs that touch PII require a human review step.
- An AI impact assessment is required before launching customer-facing features.

## 17. Audit evidence

The compliance team maintains the following evidence artifacts:

- Quarterly access review reports
- Annual penetration test results
- SOC 2 Type II report
- DPA inventory with all sub-processors
- Data retention schedule with enforcement logs

## 18. Region-specific obligations

### 18.1 GDPR (EU/EEA)

- Lawful basis documented for every processing activity.
- Data protection impact assessments for high-risk processing.
- A representative in the EU is designated for non-EU establishments.
- Binding corporate rules are not used; SCCs apply for transfers.

### 18.2 CCPA/CPRA (California)

- "Do Not Sell or Share My Personal Information" link honored at account level.
- Opt-out preference signals are respected.
- Sensitive personal information is limited to what is necessary.
- Right to correct and right to limit are implemented via the privacy portal.
- Annual metrics on consumer requests are published as required.

### 18.3 Other jurisdictions

- Brazil (LGPD): consent flows and a DPO are in place.
- UK (UK GDPR): equivalent to GDPR; the UK is treated as a separate regime.
- Japan (APPI): cross-border transfer documentation is maintained.

## 19. Data retention schedule (detailed)

| Data category | Retention | Enforcement |
|---|---|---|
| Raw behavioral events | 24 months | daily purge job |
| Aggregated metrics | 7 years | annual archival |
| Customer profile | account lifetime + 12 months | deletion job |
| Order history | 10 years | tax compliance |
| Payment records | 7 years | finance policy |
| Access logs | 18 months | log rotation |
| Webhook payloads | 30 days | purge job |
| Backups (hot) | 30 days | snapshot lifecycle |
| Backups (cold) | 1 year | archive tier |

## 20. Consent management

- Consent is captured with a timestamp and versioned policy reference.
- Withdrawal is honored within 24 hours for marketing and personalization.
- Consent records are retained for audit for 3 years after withdrawal.
- No consent is required for strictly necessary processing (billing, security).

## 21. Governance roles

| Role | Responsibility |
|---|---|
| Data Protection Officer | Oversight, authority contact |
| Privacy Counsel | Legal interpretation, DPIAs |
| Data Governance Lead | Classification, access reviews |
| Security Engineer | Technical controls, incident handling |
| Product Owners | Feature-level PII impact assessment |

## 22. Training

- All employees complete annual privacy and security training.
- Engineers with production access complete an additional technical module.
- Onboarding includes a PII-handling primer.
- Completion rates are tracked and reported to the board annually.
