---
name: apple-google-minimal-design
description: Design, redesign, implement, or review restrained product interfaces using the official principles of Apple Human Interface Guidelines and Google Material Design 3, disciplined by Swiss International Typographic Style. Use for web apps, desktop apps, mobile apps, dashboards, AI chat interfaces, plugin panels, and design-system work when the goal is clarity, low visual noise, native-feeling interaction, accessibility, and consistent hierarchy rather than decorative styling.
---

# Apple × Google Minimal Design

## Mission

Create interfaces that feel calm, legible, coherent, and native to their platform. Use Apple Human Interface Guidelines (HIG) and Google Material Design 3 (M3) as primary product-design references. Use Swiss / International Typographic Style as a secondary discipline for grid, alignment, typography, and information hierarchy.

This is a principles-based skill, not a preset theme. Do not combine recognizable Apple and Google visual motifs indiscriminately. Select the platform-appropriate interaction model, then apply a consistent visual system.

**Primary test:** every visible element must improve comprehension, navigation, feedback, or task completion. If it does none of these, remove it.

## When to activate

Activate when the user asks to:
- design, redesign, polish, or audit a UI/UX;
- establish or simplify a product design system;
- make a web, desktop, mobile, dashboard, settings, or AI-chat interface feel more native and restrained;
- reduce visual clutter, excessive cards, borders, shadows, gradients, pills, or decorative icons;
- translate Apple HIG / Material 3 / Swiss design principles into an existing codebase.

Do not activate for illustration-only, logo-only, poster, or brand-campaign work unless the user explicitly asks for product UI principles.

## Source hierarchy

Consult the official sources before making platform-specific claims. Guidance evolves; do not treat remembered component specs as immutable.

1. Apple Human Interface Guidelines: https://developer.apple.com/design/human-interface-guidelines/
   - Foundations: accessibility, color, layout, materials, motion, typography, writing.
   - Patterns and components: use platform conventions for navigation, controls, menus, toolbars, search, sheets, and dialogs.
2. Google Material Design 3: https://m3.material.io/
   - Foundations: color, typography, shape, elevation, layout, motion, accessibility.
   - Components and interaction patterns: https://m3.material.io/components
3. Android Material 3 implementation guidance: https://developer.android.com/develop/ui/compose/designsystems/material3
4. Swiss / International Typographic Style: use grid, asymmetry with order, typographic hierarchy, disciplined alignment, and reduction. Treat it as a compositional method, not a license to make every screen look like a poster.

When a specific platform is known, its official guidance takes precedence over cross-platform stylistic preference. Do not claim that a design is officially Apple- or Google-compliant without checking the relevant current guidance.

## Non-negotiable principles

### 1. Content before chrome
- Make the user's task and content the visual center.
- Keep navigation, toolbars, and metadata visually subordinate.
- Prefer direct labels and clear grouping over decorative containers.
- Use progressive disclosure for advanced, infrequent, or destructive actions.
- Do not hide essential actions merely to achieve a minimalist appearance.

### 2. Hierarchy through a small number of signals
Use, in this order:
1. placement and grouping;
2. typography and weight;
3. spacing and alignment;
4. restrained color;
5. borders, surfaces, and elevation only when needed.

Do not use size, boldness, accent color, shadow, and a container simultaneously to emphasize the same item. One or two signals are usually enough.

### 3. Deliberate restraint
- Default to a neutral surface and a limited semantic palette.
- Use one primary accent role; reserve additional accent roles for meaningful semantic distinctions.
- Avoid decorative gradients, glass effects, glow, blur, ornamental separators, oversized icons, and gratuitous animation.
- Do not wrap every section, row, or control in a card.
- Do not add a border if spacing and alignment already establish grouping.
- Do not add a shadow to simulate depth when a simple surface contrast is clearer.
- Rounded corners must communicate grouping or interaction, not serve as universal decoration.
- Avoid both extremes: sterile empty screens and dense control panels. Preserve useful information density.

### 4. Platform-native behavior
- On Apple platforms, follow the relevant HIG navigation, control, input, typography, material, and motion conventions.
- On Android, follow Material 3 semantics, components, adaptive layouts, state layers, and accessibility behavior.
- On the web, do not imitate iOS or Android chrome literally. Use familiar web semantics and responsive behavior while retaining the same hierarchy and restraint.
- For cross-platform products, share design tokens and content hierarchy, but allow platform-specific controls and navigation where user expectations differ.

### 5. Swiss compositional discipline
- Establish a consistent spacing and alignment grid before styling.
- Align titles, body content, controls, and repeated rows to intentional axes.
- Use asymmetric layouts only when they improve hierarchy or reading flow.
- Keep typography to a small, purposeful family and scale.
- Use whitespace as structure, not as an excuse to waste the viewport.
- Avoid arbitrary all-caps labels, tiny metadata, decorative numbering, and excessive tracking.

### 6. Accessibility is part of the design
- Maintain readable contrast for text, icons, borders, and interactive states.
- Never communicate status through color alone.
- Support keyboard navigation, visible focus, screen readers, and logical reading order.
- Respect system text scaling, reduced motion, and light/dark appearance.
- Ensure touch targets and hit areas meet the target platform's current guidance.
- Provide labels, descriptions, and accessible names for icon-only controls.
- Check disabled, loading, empty, error, success, hover, focus, pressed, and selected states.

## Design decision framework

Before changing UI, answer these questions from the existing product and repository:

1. **Purpose:** what is the primary task on this screen?
2. **Audience/context:** phone, tablet, desktop, web, embedded panel, or mixed?
3. **Hierarchy:** what must be noticed first, second, and third?
4. **Frequency:** which actions are primary, secondary, rare, or destructive?
5. **Density:** what information is essential, optional, or redundant?
6. **Constraints:** existing framework, component library, design tokens, assets, accessibility requirements, and performance budget?

If repository context is available, inspect the actual application before proposing a redesign. Reuse existing components and tokens where sound. Do not introduce a second design system or replace the framework merely to achieve a visual effect.

## Visual system rules

### Color
- Define semantic tokens such as `background`, `surface`, `surface-muted`, `text-primary`, `text-secondary`, `border-subtle`, `primary`, `on-primary`, `success`, `warning`, and `error`.
- Map tokens to platform themes rather than scattering raw hex values through components.
- Use neutral surfaces for most of the interface. Accent color should identify action, selection, or meaningful status.
- Support dark mode with a deliberately designed tonal mapping; do not simply invert colors.
- If M3 dynamic color is relevant, use its semantic color roles and verify contrast. Do not force dynamic color into products where brand consistency or platform support makes it inappropriate.

### Typography
- Use the platform system font where appropriate; otherwise choose one highly legible family.
- Establish a compact type scale with clear roles: display, heading, title, body, label, and supporting metadata.
- Prefer readable regular/medium weights. Do not use thin weights for small text.
- Use line length, line height, and paragraph spacing to support scanning.
- Do not shrink important text to make a layout fit; reflow the layout instead.

### Layout and spacing
- Define a base spacing scale and apply it consistently.
- Use a responsive grid and content-width constraints appropriate to the platform.
- Keep related controls close enough to read as a group, with clear separation between unrelated groups.
- Prefer one strong page structure over nested panels inside panels.
- On narrow screens, collapse columns and move secondary actions into appropriate menus or sheets without hiding critical workflows.

### Surfaces, borders, and elevation
- Start with flat surfaces.
- Introduce elevation only to clarify layering, such as a menu, popover, dialog, or floating control.
- Use separators sparingly and consistently.
- Do not combine a strong border, large radius, and shadow on every container.
- Glass/translucency is an optional platform-specific material, not the default background treatment.

### Icons and assets
- Prefer the project's existing icon set and established SVG assets.
- Keep icon stroke, size, optical alignment, and baseline consistent.
- Use icons to reinforce recognizable actions; pair unfamiliar or ambiguous icons with text.
- Do not use emoji as a substitute for interface icons.
- Do not create decorative SVGs where a label, spacing, or native control is clearer.
- Preserve meaningful SVG viewBox, accessible title/label behavior, and crisp scaling.

### Motion and feedback
- Motion must explain state change, spatial relationship, or action feedback.
- Prefer short, subtle transitions; avoid perpetual motion and attention-seeking effects.
- Respect reduced-motion preferences.
- Every action must provide a clear state response. Avoid decorative loading animations when a simple progress indicator is sufficient.

## Component guidance

- **Navigation:** use the smallest navigation structure that matches the information architecture. Avoid duplicate navigation bars and repeated active-state indicators.
- **Buttons:** one clear primary action per context where possible; secondary actions should be visually quieter. Destructive actions require clear labeling and appropriate confirmation.
- **Forms:** group related fields, use persistent labels, explain validation inline, and avoid placeholder-only labels.
- **Lists and tables:** prefer aligned rows and clear column/label hierarchy over a grid of cards.
- **Cards:** use only when content is a genuinely independent object or needs a distinct action surface.
- **Dialogs and sheets:** reserve for focused decisions or contextual tasks; do not use them for routine navigation.
- **Chat interfaces:** keep the conversation dominant, composer obvious, and secondary tools discoverable but quiet. Avoid turning every message into a card. Keep model/tool metadata subordinate and expose it progressively.
- **Dashboards:** prioritize decision-relevant metrics and trends. Avoid decorative KPI tiles, redundant charts, and color-coded noise.

## Implementation workflow

1. Inspect the current screen, routes, components, tokens, assets, responsive breakpoints, and interaction states.
2. Record the current hierarchy and identify clutter, duplication, weak affordances, and accessibility gaps.
3. Write a concise design rationale and proposed hierarchy before implementation.
4. Define or reuse semantic tokens and shared primitives.
5. Implement in small, reviewable slices. Preserve existing behavior unless the task explicitly changes it.
6. Verify desktop, tablet, and mobile layouts as applicable.
7. Verify light/dark themes, keyboard/focus behavior, reduced motion, text scaling, and all component states.
8. Run the project's existing lint, typecheck, tests, and build. Report commands and actual results; never claim checks passed without running them.

## Review checklist

A screen is ready only when the following are true:

- [ ] The primary task is obvious without decorative explanation.
- [ ] There is a clear hierarchy with no competing emphasis.
- [ ] Every visible element has a functional or informational purpose.
- [ ] Spacing and alignment follow a coherent grid.
- [ ] Color is semantic, restrained, and accessible.
- [ ] Typography remains readable at supported text sizes.
- [ ] Cards, borders, shadows, gradients, and blur are used only when justified.
- [ ] Navigation and controls behave according to the target platform.
- [ ] Interactive states and feedback are complete.
- [ ] Responsive layouts preserve content priority and usability.
- [ ] Reduced motion, keyboard access, and screen-reader semantics are considered.
- [ ] Existing project conventions and assets are reused where appropriate.
- [ ] Build, tests, and accessibility checks are reported truthfully.

## Required response format when using this skill

For a design task, report:
1. **Design direction** — the chosen platform model and why.
2. **Hierarchy** — primary content, primary action, secondary actions.
3. **System** — color, type, spacing, surfaces, icon rules.
4. **Implementation** — files/components changed and behavior preserved.
5. **Verification** — responsive, accessibility, tests, and known gaps.

Do not produce a long design manifesto for a small change. Keep the explanation proportional to the scope.
