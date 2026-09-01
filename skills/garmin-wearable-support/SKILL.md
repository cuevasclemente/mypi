---
name: garmin-wearable-support
description: Support Clemente's Garmin wearable setup, comparison, and navigation troubleshooting, especially Fenix/Venu watches, by verifying current Garmin specs/docs, explaining training/solar/battery behavior, and debugging Android Google Maps or Connect IQ navigation without exposing account credentials or precise locations unnecessarily.
---

# Garmin Wearable Support

## Setup
- Use this when Clemente asks about Garmin watches, Garmin Connect/Connect IQ apps, Fenix/Venu comparisons, fitness metrics, battery/solar behavior, or phone-to-watch navigation.
- Verify named devices/apps with current sources before giving specs:
  - Garmin official manuals, support pages, and specs pages.
  - Garmin Connect IQ app pages for current compatibility/requirements.
  - App/vendor docs for Komoot, RideWithGPS, Locus Map, dynamicWatch/routeCourse, or navigation bridge apps.
- Do not ask for Garmin/Google account passwords. Avoid exposing exact location, routes, or home/work addresses unless required and user-approved.

## Device onboarding and comparison workflow
1. **Identify the exact device/app context**
   - Model: e.g. Fenix 7 Solar, Venu 3, Epix, Forerunner.
   - Phone OS: Android vs iOS matters for notification bridge/navigation behavior.
   - Desired outcome: everyday smartwatch, training, navigation, battery life, hiking/cycling, health metrics.
2. **Verify current facts**
   - Check official model/spec pages for display type, controls, sensors, battery, solar, maps/navigation, and supported health features.
   - Label forum or anecdotal information clearly as non-official.
3. **Explain by category**
   - Identity: rugged outdoor/training watch vs lifestyle/wellness smartwatch.
   - Controls: buttons/touchscreen differences and when buttons matter.
   - Display: MIP/solar readability vs AMOLED-style smartwatch display.
   - Battery/solar: real-world expectation vs official modes.
   - Navigation: maps, courses, breadcrumbs, turn prompts, phone dependence.
   - Training metrics: VO2 max, training readiness/status/load, cycling/running requirements.
   - Health/smart features: ECG/voice/speaker/payment/music/notifications where supported.
4. **Give a short setup checklist**
   - Update watch firmware, Garmin Connect, Connect IQ, and relevant phone apps.
   - Pair Bluetooth, confirm notifications, set preferred watch faces/data screens, and test a short activity.

## Fenix/Venu patterns
- Fenix 7 Solar is usually the more rugged outdoor/training/navigation watch.
- Venu 3 is usually the more smartwatch/wellness-oriented option.
- For VO2 max, be precise: Fenix devices estimate it only from qualifying activities, commonly suitable outdoor runs or cycling with a power meter, and it is an estimate rather than a lab measurement.
- For solar, frame it as **battery-life extension**, not primary charging. It may slowly revive a dead watch in ideal sun, but do not recommend relying on solar to charge from empty.

## Google Maps and watch navigation troubleshooting
Garmin/Google Maps behavior is often not full mirroring. It may be Android-only and limited to turn prompts or notification-driven prompts depending on the app.

1. **Clarify the app path**
   - Official Garmin/Google Maps integration or Connect IQ app?
   - Third-party bridge such as Navigation through Google Maps, Maps Nav, Nav Activity Garmin?
   - Garmin-native course/navigation from Garmin Connect/Explore?
2. **Check phone and permissions layers**
   - Android notification access enabled for the bridge/Garmin app.
   - Google Maps notification channels enabled for navigation.
   - Garmin Connect smart notifications enabled.
   - Battery optimization/background restrictions disabled for Garmin Connect, Google Maps, and the bridge app.
   - Bluetooth connected and watch near phone.
3. **Check launch sequence**
   - Start navigation on phone.
   - Confirm phone shows active turn-by-turn notification.
   - Open/launch the Connect IQ app or watch widget if required.
   - Test walking route first; some integrations behave differently for driving/transit/walking/cycling.
4. **Interpret failures**
   - If third-party bridge apps see Google Maps but the official app does not, permissions are probably mostly correct and the official handshake may be immature/buggy.
   - If text is clipped on a round MIP display, look for large-font/compact-layout settings before abandoning the app.
   - If nothing appears, re-check notification permissions, reinstall the Connect IQ app, reboot phone/watch, and re-pair only if simpler steps fail.

## Alternative navigation recommendations
- **Most reliable planned routes:** Garmin native Courses/Connect/Explore, Komoot, RideWithGPS, dynamicWatch/routeCourse.
- **Closest to live Google Maps prompts:** Navigation through Google Maps, Maps Nav, Nav Activity Garmin, Locus Map integrations.
- **For hiking/cycling reliability:** prefer preloaded courses or Garmin-native navigation over live Google Maps mirroring.

## Validation examples
- After setup, run a short local route and confirm: phone notification appears, watch receives a prompt, prompt is legible, and route mode matches user need.
- For battery/solar claims, compare official spec mode with user conditions and state uncertainty.
- For feature comparisons, include source/date caveat when using third-party reports.
