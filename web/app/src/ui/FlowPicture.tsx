// The picture of the flow: the supporter sets a cap once, the creator's
// collector asks for each period's payment, and the realm checks who, how
// much and when before the coins move. CSS animates it (styles.css,
// "flow-"); under prefers-reduced-motion or Pause it is a still picture.

import { useState } from "react";
import { Icon } from "./parts";

export function FlowPicture({ amount = "1", period = "month", cap = "1.1" }: { amount?: string; period?: string; cap?: string }) {
  const label =
    `How a payment moves. Once: the supporter allows the creator’s collector at most ${cap} GNOT a ${period}, ` +
    `through Mandate only, until they stop. Then every ${period}: the collector asks for ${amount} GNOT, ` +
    `Mandate checks who is asking, how much and whether it is due, and the coins go straight to the creator.`;
  const [paused, setPaused] = useState(false);
  return (
    <figure className={paused ? "flow flow-paused" : "flow"}>
      <div className="flow-header">
        <span className="console-kicker">How a payment moves · illustration</span>
        <span className="flow-cap-pill mono">Example cap: {cap} GNOT / {period}</span>
      </div>

      {/* Wide schematic */}
      <svg viewBox="0 0 720 306" role="img" aria-label={label} className="flow-svg">
        <defs>
          <pattern id="flow-grid" width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M 24 0 L 0 0 0 24" fill="none" className="flow-grid-line" />
          </pattern>
        </defs>

        <rect x="8" y="8" width="704" height="290" rx="14" className="flow-frame-bg" />
        <rect x="8" y="8" width="704" height="290" rx="14" fill="url(#flow-grid)" className="flow-frame" />

        {/* Cap ceiling band across the top of the channel */}
        <rect x="10" y="10" width="700" height="58" rx="12" className="flow-ceiling-band" />
        <line x1="16" y1="68" x2="704" y2="68" className="flow-ceiling-line" />
        <g className="flow-cap">
          <rect x="26" y="21" width="288" height="36" rx="8" className="flow-capbox" />
          <text x="40" y="36" className="flow-eyebrow">
            SET ONCE · SIGNED BY YOU
          </text>
          <text x="40" y="51" className="flow-cap-strong">
            AT MOST {cap} GNOT A {period.toUpperCase()}
          </text>
          <path d="M116 68 V116" className="flow-thread" />
        </g>

        {/* Collector cadence callout on upper right */}
        <g className="flow-cadence">
          <path d="M492 40 a14 14 0 1 1 -1 -6" className="flow-loop" />
          <path d="M493 29 l-1 6 -6 -2" className="flow-loop" />
          <text x="518" y="36" className="flow-small">
            every {period}, the creator’s
          </text>
          <text x="518" y="52" className="flow-small">
            collector asks for {amount} GNOT
          </text>
        </g>

        {/* Payment tracks under the ceiling */}
        <path d="M180 162 H262" className="flow-track" />
        <path d="M458 162 H540" className="flow-track" />
        <path d="M180 162 H262" className="flow-track-glow" />
        <path d="M458 162 H540" className="flow-track-glow" />

        {/* Supporter node */}
        <g className="flow-node">
          <rect x="34" y="116" width="146" height="92" rx="12" className="flow-panel" />
          <path d="M90 144 h34 a5 5 0 0 1 5 5 v18 a5 5 0 0 1 -5 5 h-34 a5 5 0 0 1 -5 -5 v-18 a5 5 0 0 1 5 -5 Z M116 158 h8" className="flow-glyph" />
          <text x="107" y="191" textAnchor="middle" className="flow-label">
            Supporter
          </text>
          <text x="107" y="226" textAnchor="middle" className="flow-micro">
            YOUR WALLET
          </text>
        </g>

        {/* Mandate rulebook chamber */}
        <g className="flow-node">
          <rect x="262" y="96" width="196" height="132" rx="14" className="flow-panel flow-realm" />
          <text x="360" y="121" textAnchor="middle" className="flow-strong">
            Mandate
          </text>
          <line x1="280" y1="132" x2="440" y2="132" className="flow-divider" />
          {[
            ["who", 156],
            ["how much", 180],
            ["when", 204],
          ].map(([word, y], i) => (
            <g key={word} className={`flow-check flow-check-${i + 1}`}>
              <rect x="284" y={Number(y) - 13} width="152" height="20" rx="5" className="flow-check-bg" />
              <path d={`M294 ${Number(y) - 3} l3 3 6 -7`} className="flow-tick" />
              <text x="312" y={Number(y) + 1}>
                {word}
              </text>
            </g>
          ))}
          <text x="360" y="244" textAnchor="middle" className="flow-micro">
            THE RULEBOOK
          </text>
        </g>

        {/* Creator node */}
        <g className="flow-node">
          <rect x="540" y="116" width="146" height="92" rx="12" className="flow-panel" />
          <path d="M613 139 l5 10 11 1.5 -8 8 2 11 -10 -5.5 -10 5.5 2 -11 -8 -8 11 -1.5 Z" className="flow-glyph" />
          <text x="613" y="191" textAnchor="middle" className="flow-label">
            Creator
          </text>
          <text x="613" y="226" textAnchor="middle" className="flow-micro">
            DIRECT TRANSFER
          </text>
        </g>

        {/* Travelling payment pulse */}
        <g className="flow-coin">
          <circle r="18" className="flow-coin-halo" />
          <circle r="13" className="flow-coin-disc" />
          <text y="4" textAnchor="middle" className="flow-coin-text">
            {amount}
          </text>
        </g>

        {/* Example period timeline */}
        <g className="flow-timeline">
          <line x1="34" y1="274" x2="686" y2="274" className="flow-time-axis" />
          {[0, 1, 2, 3, 4, 5].map((i) => {
            const x = 86 + i * 110;
            return (
              <g key={i} className={`flow-beat flow-beat-${i + 1}`}>
                <line x1={x} y1="266" x2={x} y2="274" className="flow-beat-tick" />
                <circle cx={x} cy="274" r="3.5" className="flow-beat-dot" />
                <text x={x} y="290" textAnchor="middle" className="flow-micro">
                  {period === "month" ? `M${i + 1}` : `P${i + 1}`}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {/* Stacked schematic for narrow screens */}
      <svg viewBox="0 0 340 540" role="img" aria-label={label} className="flow-svg flow-svg-narrow">
        <defs>
          <pattern id="flow-grid-narrow" width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M 24 0 L 0 0 0 24" fill="none" className="flow-grid-line" />
          </pattern>
        </defs>
        <rect x="6" y="6" width="328" height="528" rx="14" className="flow-frame-bg" />
        <rect x="6" y="6" width="328" height="528" rx="14" fill="url(#flow-grid-narrow)" className="flow-frame" />
        <rect x="16" y="16" width="308" height="56" rx="10" className="flow-capbox" />
        <text x="170" y="36" textAnchor="middle" className="flow-eyebrow">
          SET ONCE · SIGNED BY YOU
        </text>
        <text x="170" y="56" textAnchor="middle" className="flow-cap-strong">
          AT MOST {cap} GNOT A {period.toUpperCase()}
        </text>
        <line x1="16" y1="80" x2="324" y2="80" className="flow-ceiling-line" />
        <path d="M170 72 V102" className="flow-thread" />

        <rect x="55" y="102" width="230" height="68" rx="12" className="flow-panel" />
        <path d="M84 126 h30 a4 4 0 0 1 4 4 v14 a4 4 0 0 1 -4 4 h-30 a4 4 0 0 1 -4 -4 v-14 a4 4 0 0 1 4 -4 Z M106 137 h7" className="flow-glyph" />
        <text x="134" y="135" className="flow-label">
          Supporter
        </text>
        <text x="134" y="152" className="flow-micro">
          YOUR WALLET
        </text>

        <path d="M170 170 V218" className="flow-track" />
        <rect x="44" y="218" width="252" height="128" rx="14" className="flow-panel flow-realm" />
        <text x="170" y="242" textAnchor="middle" className="flow-strong">
          Mandate · the rulebook
        </text>
        <line x1="64" y1="252" x2="276" y2="252" className="flow-divider" />
        {[
          ["who", 275],
          ["how much", 299],
          ["when", 323],
        ].map(([word, y], i) => (
          <g key={word} className={`flow-check flow-check-${i + 1}`}>
            <rect x="74" y={Number(y) - 13} width="192" height="20" rx="5" className="flow-check-bg" />
            <path d={`M86 ${Number(y) - 3} l3 3 6 -7`} className="flow-tick" />
            <text x="104" y={Number(y) + 1}>
              {word}
            </text>
          </g>
        ))}

        <path d="M170 346 V394" className="flow-track" />
        <rect x="55" y="394" width="230" height="68" rx="12" className="flow-panel" />
        <path d="M99 415 l4.5 9 10 1.5 -7 7 1.5 10 -9 -4.8 -9 4.8 1.5 -10 -7 -7 10 -1.5 Z" className="flow-glyph" />
        <text x="134" y="427" className="flow-label">
          Creator
        </text>
        <text x="134" y="444" className="flow-micro">
          DIRECT TRANSFER
        </text>

        <g className="flow-coin flow-coin-v">
          <circle r="17" className="flow-coin-halo" />
          <circle r="12" className="flow-coin-disc" />
          <text y="4" textAnchor="middle" className="flow-coin-text">
            {amount}
          </text>
        </g>

        <text x="170" y="492" textAnchor="middle" className="flow-small">
          every {period}, the creator’s collector
        </text>
        <text x="170" y="510" textAnchor="middle" className="flow-small">
          asks for {amount} GNOT
        </text>
      </svg>

      <figcaption className="muted small">
        <p>Nothing is locked up front: each payment goes from the supporter to the creator in one transaction, and the realm keeps nothing.</p>
        {/* the picture loops: a way to stop it (WCAG 2.2.2); hidden under reduced motion, where it is still */}
        <button type="button" className="btn btn-quiet flow-toggle" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
          <Icon name={paused ? "play" : "pause"} />
          {paused ? "Play the picture" : "Pause the picture"}
        </button>
      </figcaption>
    </figure>
  );
}
