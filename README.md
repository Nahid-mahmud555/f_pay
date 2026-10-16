# F Pay — A Protective Digital Wallet Framework

### Your Money. Your Control. Your Security.

**Project Category:** FinTech · Digital Wallet Security · Financial Risk Awareness  
**Project Type:** Prototype & System Design  
**Researcher:** Nahid Mahmud  
**Affiliation:** Department of Computer Science and Engineering, Varendra University, Bangladesh

---

## 1. Project Overview

Digital wallets have made financial transactions faster and more convenient. However, users may still face challenges such as unexpected spending, unauthorized transactions, financial fraud, and situations where they are pressured into transferring money.

**F Pay** is a protective digital wallet concept designed to explore how financial organization, transaction-context awareness, and user-controlled security features can work together within a single system.

Instead of focusing only on storing balances and recording transactions, F Pay introduces an additional protection-oriented layer that aims to help users review potentially unexpected or risky transactions before proceeding.

The project combines a structured virtual money-management model, purpose-aware budget monitoring, transaction risk awareness, and protected access into one unified framework.

## 2. The Core Idea Behind F Pay

F Pay is built around three principles:

- **Organize:** Give users more structured control over how their wallet balance is allocated.
- **Understand:** Compare intended spending with the context of a proposed transaction.
- **Protect:** Provide useful warnings and security checks before a user proceeds.

The objective is to make digital financial interactions more transparent and deliberate without unnecessarily complicating the user experience.

## 3. The 20-Layer Money Management System

One of F Pay's central design elements is its **20-layer virtual money management system**.

Rather than presenting all available money as a single undifferentiated balance, the proposed interface allows users to organize portions of their available balance into separately named virtual layers.

Each layer can represent a user-defined financial purpose, such as education, food, transportation, savings, subscriptions, emergency funds, or personal expenses.

### Example: A 20-Layer Wallet

| Layer | Example purpose |
|---|---|
| Layer 01 | Daily Essentials |
| Layer 02 | Food & Groceries |
| Layer 03 | Transportation |
| Layer 04 | Education |
| Layer 05 | Internet & Mobile |
| Layer 06 | Subscriptions |
| Layer 07 | Health & Wellness |
| Layer 08 | Emergency Reserve |
| Layer 09 | Personal Savings |
| Layer 10 | Family Support |
| Layer 11 | Shopping |
| Layer 12 | Entertainment |
| Layer 13 | Skill Development |
| Layer 14 | Technology |
| Layer 15 | Travel |
| Layer 16 | Bills & Utilities |
| Layer 17 | Gifts & Donations |
| Layer 18 | Future Goals |
| Layer 19 | Business & Projects |
| Layer 20 | Custom Purpose |

*These are illustrative categories, not fixed requirements. Users can define their own layer names and purposes.*

### How the Layer Model Works

1. The user views the main wallet balance.
2. The user allocates available funds to selected virtual layers.
3. Each layer maintains its own logical allocation and associated information.
4. Access to protected layer operations can require additional authentication.
5. The interface helps the user understand which funds are allocated to which purposes.

The layers are a **logical organization of funds**, not 20 separate bank accounts. In the current prototype, all transactions are simulated; the design does not represent independently held or guaranteed protected funds.

## 4. System Architecture

The architecture separates the user interface, access controls, money organization, transaction assessment, and transaction simulation.

```text
                 USER
                   |
                   v
          +------------------+
          |  F Pay Interface |
          +------------------+
                   |
                   v
          +------------------+
          | Authentication & |
          | Access Control   |
          +------------------+
                   |
                   v
          +------------------+
          | Wallet Dashboard |
          +------------------+
                   |
                   v
          +------------------+
          | 20-Layer Money   |
          | Management       |
          +------------------+
                   |
                   v
          +------------------+
          | Transaction      |
          | Assessment Layer |
          +------------------+
                   |
          +--------+--------+
          |                 |
          v                 v
 +----------------+  +----------------+
 | Budget & Plan  |  | Security & Risk |
 | Comparison     |  | Awareness       |
 +----------------+  +----------------+
          |                 |
          +--------+--------+
                   |
                   v
          +------------------+
          | Warning / Review |
          +------------------+
                   |
                   v
          +------------------+
          | User Confirmation|
          +------------------+
                   |
                   v
          +------------------+
          | Simulated        |
          | Transaction & Log|
          +------------------+
```

### Architectural Principle

F Pay is designed around a modular structure. This allows its money-management interface, budget features, access controls, and transaction assessment to evolve independently as the prototype matures.

The architecture represents the proposed workflow; production payment authorization and enforcement would require appropriate backend infrastructure and integration with an authorized financial service provider.

## 5. Key Features

### 5.1 Purpose-Based Money Organization

The 20-layer model allows users to separate their financial intentions into manageable virtual allocations. This can make planned spending easier to understand and review.

### 5.2 Transaction Risk Awareness

F Pay explores ways to assess transaction context and highlight activity that may deserve additional attention.

A warning is intended to support user judgment—not to claim that a transaction is definitely fraudulent or that every fraud attempt can be detected.

### 5.3 AI Sub — Smart Budget Assistant

AI Sub is the proposed budgeting component of F Pay.

Users can create spending plans with a title, an optional layer association, an amount, and a reporting interval. The system can compare a proposed expense with the relevant saved plan.

For example, if a user has planned ৳500 for a subscription but proposes spending ৳1,000, F Pay can display a budget discrepancy warning before the user proceeds.

This is an illustrative budget-checking workflow; it does not imply that every feature currently uses a trained AI model.

### 5.4 Pre-Transaction Review

When the system identifies a relevant discrepancy or potential concern, the interface can show an alert and provide the user with an opportunity to review the transaction.

A prototype warning does not itself stop a real payment. Enforcing a hold or rejection would require an authorized payment-provider integration.

### 5.5 Protected Access & Recovery

The concept includes PIN-based access, OTP verification in the demonstration workflow, and configurable recovery options.

These controls are intended to strengthen account access management. A valid PIN or OTP alone cannot establish that a transaction is voluntary, nor can these mechanisms guarantee protection from coercion.

### 5.6 Isolated Demonstration Mode

A separate sandbox mode can demonstrate the wallet experience using fictional balances and transaction records. It is intended for testing and presentations, with simulated activity kept separate from real payment claims.

---

## 6. F Pay vs. a Conventional Wallet

The following comparison describes the intended design scope of F Pay, not a claim that every existing wallet lacks the listed capabilities.

| Capability | Conventional wallet baseline | F Pay design focus |
|---|---|---|
| Balance display | View available balance | Balance plus purpose-based organization |
| Money allocation | Depends on the provider | 20 configurable virtual layers |
| Budget planning | Varies by application | AI Sub planning and comparison concept |
| Spending alerts | Depends on provider rules | Contextual review of planned vs. proposed spending |
| Transaction assessment | Varies by provider | Dedicated risk-awareness design layer |
| Access security | Provider-specific controls | PIN/OTP demonstration and configurable access workflow |
| Coercion-related protection | Depends on provider capabilities | A research direction requiring specialized safety design |
| Payment execution | Supported by integrated providers | Simulated in the current prototype |

**The key distinction:** F Pay explores how money organization and transaction-context awareness can be brought together in one protective workflow.

## 7. Example User Scenario

Imagine a student who allocates funds across education, transport, food, subscriptions, and emergency savings.

The student has set a planned subscription budget of ৳500. Later, they initiate a transaction of ৳1,000 for the same purpose.

A possible F Pay workflow is:

1. The user enters the proposed transaction.
2. The system checks the relevant saved spending plan.
3. A discrepancy is identified.
4. The interface displays a review warning.
5. The user reviews the information and decides how to proceed within the prototype.

This illustrates **purpose-aware spending support**. It does not prove fraud, identify the user's intention with certainty, or guarantee that a harmful transaction will be prevented.

## 8. Security and Privacy Considerations

Financial protection requires more than a visually convincing interface. A practical implementation would need to consider:

- Secure authentication and appropriately protected credentials.
- Server-side authorization for sensitive operations.
- Transaction integrity and consistent balance accounting.
- Rate limits and monitoring for repeated authentication attempts.
- Secure handling of recovery methods and OTPs.
- Audit logs with appropriate access controls.
- Privacy-conscious collection and retention of personal and financial information.
- Threat modelling, testing, and independent security review.

F Pay's long-term direction also considers fraud and coercion-related risks. These are difficult problems: a user may enter valid credentials under pressure, and unusual transaction behaviour can have legitimate explanations. Any advanced protective workflow would need careful evaluation to avoid false alarms or creating additional risks for vulnerable users.

## 9. Current Prototype and Future Scope

### Current Prototype

- 20-layer wallet interface.
- User-defined virtual money organization.
- Demonstration-level PIN and OTP workflows.
- Budget-planning and transaction-review concepts.
- Simulated transaction history.
- Isolated sandbox demonstration.

### Future Research and Development

- Stronger transaction-context analysis.
- Evaluation of risk indicators using appropriately sourced, privacy-protected test data.
- Improved security testing and usability evaluation.
- Careful research into coercion-aware user safety.
- Authorized provider integration for real transaction review or enforcement.
- Scalability studies for more configurable money-management layers.

These are planned directions, not claims of completed capabilities.

## 10. Research and Evaluation Plan

F Pay can be evaluated through controlled scenarios covering ordinary transactions, budget discrepancies, suspicious patterns, authentication failures, and simulated coercion-related situations.

Potential evaluation measures include:

- Accuracy of budget discrepancy detection.
- False-positive and false-negative rates for any defined risk classifier.
- Time required for users to understand and respond to warnings.
- Authentication and authorization test results.
- Usability and accessibility feedback.

No fraud-detection accuracy, fraud-reduction rate, or coercion-detection performance is claimed without measured experimental evidence.

## 11. Relevant References

The design is informed by established work and security guidance relevant to financial behaviour, authentication, and account recovery.

1. Thaler, R. H. (1999). “Mental Accounting Matters.” *Journal of Behavioral Decision Making, 12*(3), 183–206. https://doi.org/10.1002/(SICI)1099-0771(199909)12:3%3C183::AID-BDM318%3E3.0.CO;2-F

2. OWASP Foundation. *Multifactor Authentication Cheat Sheet.* https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html

3. OWASP Foundation. *Forgot Password Cheat Sheet.* https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html

4. Bangladesh Bank. *Bangladesh Mobile Financial Services (MFS) Regulations, 2022.* Refer to the official Bangladesh Bank website for the applicable regulatory text: https://www.bb.org.bd/

These references provide background and security guidance; they do not independently validate F Pay's proposed effectiveness.

## 12. Conclusion

F Pay proposes a protective digital wallet framework that brings together **20-layer virtual money management, purpose-aware budget comparison, transaction risk awareness, and user-controlled security workflows**.

Its central idea is to help users organize their money and make more informed decisions before proceeding with a transaction.

The current prototype is a foundation for demonstrating and evaluating that concept. Real-world fraud prevention, coercion-aware intervention, and payment enforcement remain areas for further research, rigorous testing, and appropriate financial-service integration.

**F Pay — More than tracking money. A framework for more thoughtful, security-aware financial decisions.**
