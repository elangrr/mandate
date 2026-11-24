# Mandate

Subscriptions and direct debit on native GNOT: a supporter allows a creator to take a fixed amount once per period, under a cap the chain enforces.

## People

**Supporter**:
A wallet that pays a creator through a mandate.
_Avoid_: payer (except in the realm's API and commands), subscriber, user, customer

**Creator**:
A wallet that publishes plans and receives the payments.
_Avoid_: payee (except in the realm's API and commands), merchant, owner, seller

## Things

**Plan**:
A creator's fixed terms: an amount of GNOT every period, with a title. A plan never changes; new terms mean a new plan.
_Avoid_: tier, product, subscription

**Mandate**:
One supporter's agreement to pay one plan, recorded in the realm, with an end date.
_Avoid_: subscription (as a noun for this record), pledge

**Permission**:
What a supporter signs in their own wallet so the creator's collector can take payments: at most the cap per period, through Mandate only, until its end date. The chain calls it a session.
_Avoid_: session (outside commands and technical notes), approval, allowance

**Collector key**:
A separate key the creator publishes; supporters give it their permission, and it asks for each payment.
_Avoid_: session key (outside commands), bot, service key

**Collector**:
The creator's program that takes each payment when it is due, signed with the collector key.
_Avoid_: puller, bot, cron

## Money and time

**Price**:
The plan's amount per period.
_Avoid_: fee, rate

**Period**:
The time between two payments of a plan, from one minute to 30 days.
_Avoid_: interval, cycle, term

**Cap**:
The most a permission lets the collector take per period: the price plus the fee allowance.
_Avoid_: spend limit (outside commands), budget, maximum

**Fee allowance**:
The part of the cap reserved for the network fees and storage of a payment: 0.1 GNOT.
_Avoid_: gas allowance, buffer

**Payment**:
One successful transfer of the price from a supporter to a creator.
_Avoid_: pull (outside the realm's API and commands), charge, debit

**Paid through**:
The time until which a supporter's payments for a plan cover them; time paid for is kept when a mandate ends and carried into the next mandate for the same plan.
_Avoid_: paid until, valid until, subscription end

**Storage deposit**:
GNOT the chain holds for the bytes a transaction stores, paid by whoever stores them.
_Avoid_: storage fee, rent

## States

**Active**:
A mandate that is neither cancelled nor past its end date, and whose permission still exists on chain.
_Avoid_: live, running

**Stopped on chain**:
A mandate still recorded as active in the realm whose permission is gone (revoked or expired) on chain, so no payment can be taken.
_Avoid_: broken, invalid

**Cancelled**:
A mandate ended in the realm by its supporter or its creator.
_Avoid_: deleted, unsubscribed

**Ended**:
A mandate past its end date.
_Avoid_: expired (in page text), finished

**Waiting for approval**:
The realm is deployed but parked until the network's package approver enables it.
_Avoid_: pending, offline, broken
