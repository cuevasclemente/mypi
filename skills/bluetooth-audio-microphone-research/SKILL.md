---
name: bluetooth-audio-microphone-research
description: Help Clemente choose and troubleshoot Bluetooth headphone plus separate microphone setups by preserving high-quality A2DP/LE stereo output, avoiding HFP/HSP quality traps, verifying current product specs, and recommending USB/2.4 GHz mic paths without inventing device capabilities.
---

# Bluetooth Audio + Microphone Research

## Setup
- Use this when Clemente asks about Bluetooth headphones, headset microphones, wireless lavs, ModMic, USB Bluetooth audio dongles, A2DP/HFP/HSP/LE Audio, PipeWire/PulseAudio, gaming/call audio quality, or preserving stereo headphone quality while using a separate mic.
- Check Memoriki first for Clemente's current devices, OS, and preferences when relevant.
- For named products, verify current manufacturer pages or official docs before stating codec support, mic support, battery life, weight, bundle contents, or price.
- Do not read secrets. Browser/account logins are not needed for normal product/spec research.

## Core principles
- Classic Bluetooth usually has a split between:
  - **A2DP stereo output** for music/high-quality listening.
  - **HFP/HSP headset/call mode** for bidirectional mic+speaker, often with much worse output quality.
- If the goal is high-quality headphone output during calls, prefer **separate input and output devices**:
  - Output: headphones in A2DP/stereo (or a known-good LE Audio path).
  - Input: USB mic, USB audio interface, or 2.4 GHz wireless mic receiver.
- Be skeptical of “Bluetooth lapel mic” or “Bluetooth headphone dongle with mic” claims. Many either cannot use the headphone mic while maintaining A2DP, or switch the whole link to HFP/call mode.
- USB-C/USB-A 2.4 GHz creator lav kits often appear to the OS as a USB microphone and can coexist with Bluetooth A2DP output.
- Boom mics close to the mouth usually beat lavs for keyboard/room-noise rejection, even if lavs are smaller and more discreet.

## Workflow
1. **Clarify the actual setup**
   - OS and audio stack: Linux/PipeWire, Windows, macOS, Android/iOS, console, etc.
   - Headphones/earbuds model and supported codecs.
   - Call app(s): Zoom, Discord, Matrix/Element, browser WebRTC, games, console party chat.
   - Constraints: desk vs travel, noise/keyboard environment, budget, latency tolerance, charging while in use, USB-A/USB-C ports.

2. **Inspect current routing assumptions**
   - Explain that the call app should select the separate mic as input and the Bluetooth stereo/A2DP device as output.
   - On Linux, mention PipeWire/PulseAudio profiles and verify that the headphones remain in a stereo playback profile instead of HFP/HSP.
   - On consoles, distinguish controller microphone paths from PC USB-audio paths; controller-specific dongles may not help on desktop.

3. **Research named products carefully**
   - Fetch official pages for each SKU/model before describing specs.
   - Verify codec/profile support (SBC/AAC/aptX variants/LDAC/LC3/LE Audio), mic behavior, platform compatibility, battery life, weight, and included receivers/adapters.
   - Quote uncertainty when a product page is ambiguous, especially around “mic support,” “call mode,” and whether premium codecs remain active during microphone use.

4. **Rank solution families**
   - **Keep/use ModMic Wireless or similar boom mic** when voice quality and noise rejection matter most.
   - **USB desk mic/dynamic mic** when stationary and highest reliability is desired.
   - **2.4 GHz USB wireless lav kit** when portability/discreetness matters, accepting more room pickup.
   - **Bluetooth dongle/LE Audio route** only when the headphones, dongle, OS, and app are verified to support the desired bidirectional profile without quality loss.
   - **Avoid** generic Bluetooth lapel mics or unspecified headset-profile dongles for preserving A2DP quality.

5. **Give practical setup/testing steps**
   - Pair/connect headphones; choose the stereo/A2DP output profile.
   - Plug in mic receiver; set app/system input to that USB mic.
   - Test with a call recorder or app test call; listen for headphone profile switching, latency, noise gating, and room pickup.
   - If audio quality collapses during the test, check whether the app selected the Bluetooth headset microphone or forced HFP/HSP.

## Response pattern
- Start with the likely best path in one or two sentences.
- Separate “what preserves headphone quality” from “what improves microphone quality.”
- Include a short product comparison table only after verifying specs.
- State tradeoffs plainly: voice quality/noise rejection, portability, latency, battery, platform compatibility, cost.
- Avoid invented numeric specs or prices; if not verified, omit or label as unverified.

## Validation
- The recommendation preserves the user’s intended output quality or explicitly says when it cannot.
- Named product specs are sourced from current official/manufacturer pages or clearly labeled uncertain.
- The answer explains the A2DP-vs-HFP/HSP trap and how to avoid accidental profile switching.
- The answer gives at least one concrete test or configuration check the user can perform.

## Source-session techniques
- In the source session, the useful reusable pattern was: compare a known good separate boom mic (Antlion ModMic Wireless) against USB/2.4 GHz lav kits; verify official pages for Bluetooth dongles; and flag that dongles advertising microphone/call support often require HFP/call mode or do not support Bluetooth headphone microphones while maintaining high-quality stereo output.
