---
name: travel-rewards-flight-planning
description: Evaluate flight redemptions and cash fares for credit-card points trips, especially Amex Membership Rewards, transfer partners, award availability, transfer bonuses, orphaned balances, and cents-per-point tradeoffs without handling login credentials.
---

# Travel Rewards Flight Planning

Use this skill when Clemente asks whether to use points or cash for a flight, how to search award options, or how to value a specific redemption.

## Setup

- Check Memoriki first for travel preferences, home airport assumptions, card portfolio, point balances, and known constraints.
- Use ExaSearch or official airline/program pages for current transfer partners, award rules, transfer bonuses, baggage rules, and schedule caveats.
- Do **not** ask for or accept passwords, OTP codes, full card numbers, or loyalty-account credentials.
- Live award inventory often requires interactive airline websites. If you cannot search directly, give exact search instructions and ask the user to paste non-sensitive results or screenshots.

## Workflow

1. **Clarify the trip**
   - Origin/destination airports and acceptable alternates.
   - Dates, flexibility, one-way vs round trip, number of travelers.
   - Cabin, baggage, nonstop preference, schedule tolerance.
   - Cash fare baseline for a comparable ticket.

2. **Identify usable currencies**
   - Credit-card points available (Amex MR, Chase UR, etc.).
   - Existing airline balances that may be stranded or expiring.
   - Transfer partners and transfer ratios.
   - Active transfer bonuses, verified on the user’s issuer transfer page before transfer.

3. **Search in the right order**
   - Start with partners that price the route favorably and can access relevant airline inventory.
   - For Amex domestic U.S. trips, common checks include:
     - Air Canada Aeroplan for United-operated flights.
     - Virgin Atlantic for Delta-operated flights, especially nonstop routes.
     - Delta directly as a sanity check, noting Amex→Delta excise fees.
     - Avios/BA/Iberia/Qatar for American/Alaska only if distance and segment pricing make sense.
   - Search one-ways as well as round trips to isolate good legs.

4. **Calculate redemption value**
   - Use comparable cash fare, not the most expensive irrelevant fare.
   - Formula:
     ```text
     cents per point = (cash fare - award taxes/fees) / points used * 100
     ```
   - Account for points earned on a cash ticket, baggage included/excluded, cancellation flexibility, and routing quality.
   - If using an existing orphaned airline balance, separate the *new transferable points cost* from the value of already-stranded points.

5. **Recommend a decision**
   - State clear thresholds: book with points, maybe, or pay cash.
   - Warn not to transfer flexible points until the award is visible and the user is ready to book.
   - If a transfer bonus changes the math, show both with-bonus and no-bonus values.

## Examples

### Amex MR: LAX–BNA round trip

- Cash fare: `$450`
- Aeroplan award: `15k each way = 30k points + taxes`
- Value before taxes: `450 / 30000 = 1.5 cpp`
- If taxes are `$50`, net value: `(450 - 50) / 30000 = 1.33 cpp`
- If the user already has `15k` Aeroplan points and only needs to transfer `15k` MR, the practical decision improves because it burns an otherwise less-useful balance.

### User-pasted award result checklist

Ask for:
- Program/airline and operating airline.
- Points required per leg and total.
- Cash taxes/fees.
- Departure/arrival times and layovers.
- Cabin/basic-economy restrictions.
- Comparable cash price.

## Validation

Before final advice, verify:
- Dates and traveler count match the search.
- Award is bookable, not waitlisted or mixed-cabin in a misleading way.
- Transfer ratio/bonus is current.
- Taxes/fees and baggage/cabin restrictions are included.
- The user understands transfers are usually irreversible.

## Source session patterns

- 2026-05-18 Amex MR Nashville trip: compared `$400–500` cash fare against Aeroplan, Virgin/Delta, Delta direct, Amex portal, transfer bonuses, and existing Aeroplan balance.
