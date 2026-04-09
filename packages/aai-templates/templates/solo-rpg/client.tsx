/** @jsxImportSource react */

import {
  ChatView,
  defineClient,
  SidebarLayout,
  StartScreen,
  useToolResult,
} from "@alexkroman1/aai-ui";
import { useEffect, useState } from "react";
import type {
  ClockData,
  Disposition,
  GameState,
  NPC,
  SoloRpgToolResults,
  StoryInfo,
} from "./shared.ts";

const INITIAL: GameState = {
  initialized: false,
  phase: "genre",
  settingGenre: "",
  settingTone: "",
  settingArchetype: "",
  settingDescription: "",
  playerName: "",
  characterConcept: "",
  edge: 1,
  heart: 1,
  iron: 1,
  shadow: 1,
  wits: 1,
  health: 5,
  spirit: 5,
  supply: 5,
  momentum: 2,
  maxMomentum: 10,
  currentLocation: "",
  currentSceneContext: "",
  timeOfDay: "",
  chaosFactor: 5,
  crisisMode: false,
  gameOver: false,
  sceneCount: 0,
  npcs: [],
  clocks: [],
  storyBlueprint: null,
  kidMode: false,
  sessionLog: [],
};

// ── Color Palette ────────────────────────────────────────────────────────────
const C = {
  bg: "#0a0a0c",
  surface: "#0f0f12",
  surfaceLight: "#16161b",
  border: "#1e1e26",
  borderLight: "#2a2a36",
  accent: "#c9a84c",
  accentDim: "#8a7232",
  accentGlow: "rgba(201,168,76,0.15)",
  text: "#e0dcd0",
  textMuted: "rgba(224,220,208,0.5)",
  textDim: "rgba(224,220,208,0.25)",
  health: "#8b3030",
  healthBright: "#c44040",
  spirit: "#3a5a8a",
  spiritBright: "#5a8acd",
  supply: "#4a6a3a",
  supplyBright: "#6a9a4a",
  chaos: { low: "#3a6a3a", mid: "#8a7a3a", high: "#8a4a2a", critical: "#8b2020" },
  disposition: {
    hostile: "#c44040",
    distrustful: "#c47a30",
    neutral: "#888888",
    friendly: "#4a9a4a",
    loyal: "#c9a84c",
  },
  threat: "#8b2020",
  progress: "#3a7a9a",
  scheme: "#7a4a8a",
};

const DISP_ICON: Record<Disposition, string> = {
  hostile: "\u2620",
  distrustful: "\u26A0",
  neutral: "\u25CB",
  friendly: "\u2665",
  loyal: "\u2726",
};

const TIME_LABELS: Record<string, string> = {
  early_morning: "Dawn",
  morning: "Morning",
  midday: "Midday",
  afternoon: "Afternoon",
  evening: "Dusk",
  late_evening: "Twilight",
  night: "Night",
  deep_night: "Witching Hour",
};

const GENRE_LABELS: Record<string, string> = {
  dark_fantasy: "Dark Fantasy",
  high_fantasy: "High Fantasy",
  science_fiction: "Sci-Fi",
  horror_mystery: "Horror / Mystery",
  steampunk: "Steampunk",
  cyberpunk: "Cyberpunk",
  urban_fantasy: "Urban Fantasy",
  victorian_crime: "Victorian Crime",
  historical_roman: "Historical",
  fairy_tale: "Fairy Tale",
  slice_of_life_90s: "Slice of Life",
  outdoor_survival: "Survival",
};

const PHASE_LABELS: Record<string, string> = {
  setup: "Act I",
  confrontation: "Act II",
  climax: "Act III",
  ki_introduction: "Ki",
  sho_development: "Sho",
  ten_twist: "Ten",
  ketsu_resolution: "Ketsu",
};

// ── Components ───────────────────────────────────────────────────────────────

function ResourceBar({
  label,
  current,
  max,
  color,
  colorBright,
  icon,
}: {
  label: string;
  current: number;
  max: number;
  color: string;
  colorBright: string;
  icon: string;
}) {
  const pips = [];
  for (let i = 0; i < max; i++) {
    const filled = i < current;
    pips.push(
      <div
        key={i}
        style={{
          width: "18px",
          height: "10px",
          borderRadius: "2px",
          background: filled
            ? `linear-gradient(135deg, ${color}, ${colorBright})`
            : "rgba(255,255,255,0.03)",
          border: `1px solid ${filled ? colorBright : "rgba(255,255,255,0.06)"}`,
          boxShadow: filled ? `0 0 4px ${color}66` : "none",
          transition: "all 0.4s ease",
        }}
      />,
    );
  }
  return (
    <div style={{ marginBottom: "8px" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "3px",
        }}
      >
        <span style={{ fontSize: "10px", color: C.textDim, letterSpacing: "0.05em" }}>
          {icon} {label}
        </span>
        <span
          style={{ fontSize: "11px", fontWeight: 700, color: current > 0 ? colorBright : C.threat }}
        >
          {current}
        </span>
      </div>
      <div style={{ display: "flex", gap: "2px" }}>{pips}</div>
    </div>
  );
}

function MomentumTrack({ momentum, max }: { momentum: number; max: number }) {
  const range: number[] = [];
  for (let i = -6; i <= 10; i++) range.push(i);
  return (
    <div style={{ marginBottom: "8px" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "3px",
        }}
      >
        <span style={{ fontSize: "10px", color: C.textDim, letterSpacing: "0.05em" }}>
          Momentum
        </span>
        <span
          style={{
            fontSize: "11px",
            fontWeight: 700,
            color: momentum > 0 ? C.spiritBright : momentum < 0 ? C.healthBright : C.textMuted,
          }}
        >
          {momentum > 0 ? "+" : ""}
          {momentum}
        </span>
      </div>
      <div style={{ display: "flex", gap: "1px" }}>
        {range.map((v) => (
          <div
            key={v}
            style={{
              flex: 1,
              height: "6px",
              borderRadius: "1px",
              background:
                v > max
                  ? "rgba(255,255,255,0.01)"
                  : v <= momentum && v > 0
                    ? C.spiritBright
                    : v >= momentum && v < 0
                      ? C.healthBright
                      : v === 0
                        ? "rgba(255,255,255,0.12)"
                        : "rgba(255,255,255,0.03)",
              boxShadow:
                v <= momentum && v > 0
                  ? `0 0 3px ${C.spirit}`
                  : v >= momentum && v < 0
                    ? `0 0 3px ${C.health}`
                    : "none",
              transition: "all 0.3s ease",
            }}
          />
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: "1px" }}>
        <span style={{ fontSize: "7px", color: C.textDim }}>-6</span>
        <span style={{ fontSize: "7px", color: C.textDim }}>0</span>
        <span style={{ fontSize: "7px", color: C.textDim }}>+10</span>
      </div>
    </div>
  );
}

function ChaosGauge({ chaos }: { chaos: number }) {
  const pct = ((chaos - 3) / 6) * 100;
  const color =
    chaos <= 4
      ? C.chaos.low
      : chaos <= 6
        ? C.chaos.mid
        : chaos <= 8
          ? C.chaos.high
          : C.chaos.critical;
  const label = chaos <= 4 ? "Calm" : chaos <= 6 ? "Tense" : chaos <= 8 ? "Volatile" : "Critical";
  return (
    <div style={{ marginBottom: "8px" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "3px",
        }}
      >
        <span style={{ fontSize: "10px", color: C.textDim, letterSpacing: "0.05em" }}>Chaos</span>
        <span
          style={{
            fontSize: "9px",
            fontWeight: 600,
            color,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
        >
          {label} ({chaos})
        </span>
      </div>
      <div
        style={{
          height: "4px",
          borderRadius: "2px",
          background: "rgba(255,255,255,0.04)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            borderRadius: "2px",
            background: `linear-gradient(90deg, ${C.chaos.low}, ${color})`,
            boxShadow: `0 0 6px ${color}66`,
            transition: "width 0.5s ease, background 0.5s ease",
          }}
        />
      </div>
    </div>
  );
}

function StatPip({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div
        style={{
          fontSize: "8px",
          color: C.textDim,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: "18px",
          fontWeight: 700,
          color: C.accent,
          lineHeight: 1,
          textShadow: `0 0 8px ${C.accentGlow}`,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function ClockDisplay({ clock }: { clock: ClockData }) {
  const typeColor =
    clock.clockType === "threat"
      ? C.threat
      : clock.clockType === "progress"
        ? C.progress
        : C.scheme;
  const segments = [];
  for (let i = 0; i < clock.segments; i++) {
    segments.push(
      <div
        key={i}
        style={{
          width: "10px",
          height: "10px",
          borderRadius: "50%",
          background: i < clock.filled ? typeColor : "rgba(255,255,255,0.04)",
          border: `1px solid ${i < clock.filled ? typeColor : "rgba(255,255,255,0.08)"}`,
          boxShadow: i < clock.filled ? `0 0 4px ${typeColor}66` : "none",
          transition: "all 0.3s ease",
        }}
      />,
    );
  }
  const isFull = clock.filled >= clock.segments;
  return (
    <div
      style={{
        marginBottom: "8px",
        padding: "6px 8px",
        borderRadius: "4px",
        background: "rgba(255,255,255,0.015)",
        border: `1px solid ${isFull ? typeColor : "rgba(255,255,255,0.04)"}`,
        opacity: isFull ? 0.5 : 1,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "4px",
        }}
      >
        <span style={{ fontSize: "10px", fontWeight: 600, color: C.text }}>{clock.name}</span>
        <span
          style={{
            fontSize: "8px",
            padding: "1px 4px",
            borderRadius: "2px",
            background: `${typeColor}22`,
            color: typeColor,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            border: `1px solid ${typeColor}44`,
          }}
        >
          {clock.clockType}
        </span>
      </div>
      <div style={{ display: "flex", gap: "3px", flexWrap: "wrap" }}>{segments}</div>
    </div>
  );
}

function NpcCard({ npc }: { npc: NPC }) {
  const dispColor = C.disposition[npc.disposition] || C.textMuted;
  const icon = DISP_ICON[npc.disposition] || "\u25CB";
  return (
    <div
      style={{
        marginBottom: "6px",
        padding: "6px 8px",
        borderRadius: "4px",
        background: "rgba(255,255,255,0.015)",
        borderLeft: `2px solid ${dispColor}`,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: "11px", fontWeight: 600, color: C.text }}>{npc.name}</span>
        <span style={{ fontSize: "10px", color: dispColor }}>{icon}</span>
      </div>
      {npc.agenda && (
        <div style={{ fontSize: "9px", color: C.textMuted, marginTop: "2px", fontStyle: "italic" }}>
          {npc.agenda}
        </div>
      )}
      <div style={{ display: "flex", gap: "8px", marginTop: "3px" }}>
        <span style={{ fontSize: "8px", color: C.textDim }}>{npc.disposition}</span>
        {npc.bond !== 0 && (
          <span style={{ fontSize: "8px", color: npc.bond > 0 ? C.supplyBright : C.healthBright }}>
            bond {npc.bond > 0 ? "+" : ""}
            {npc.bond}
          </span>
        )}
      </div>
    </div>
  );
}

function StoryArc({ story }: { story: StoryInfo }) {
  const pct = story.totalActs > 0 ? ((story.currentAct - 1) / story.totalActs) * 100 : 0;
  const phaseLabel = PHASE_LABELS[story.currentPhase] || story.currentPhase;
  return (
    <div style={{ marginBottom: "8px" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "3px",
        }}
      >
        <span style={{ fontSize: "10px", color: C.textDim, letterSpacing: "0.05em" }}>
          Story Arc
        </span>
        <span style={{ fontSize: "9px", color: C.accent }}>
          {phaseLabel} ({story.currentAct}/{story.totalActs})
        </span>
      </div>
      <div
        style={{
          height: "3px",
          borderRadius: "2px",
          background: "rgba(255,255,255,0.04)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            borderRadius: "2px",
            background: `linear-gradient(90deg, ${C.accentDim}, ${C.accent})`,
            transition: "width 0.5s ease",
          }}
        />
      </div>
      {story.storyComplete && (
        <div
          style={{
            fontSize: "8px",
            color: C.accent,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            marginTop: "3px",
            textAlign: "center",
          }}
        >
          Story Complete
        </div>
      )}
    </div>
  );
}

// ── Sidebar ──────────────────────────────────────────────────────────────────

function Sidebar({ game }: { game: GameState }) {
  return (
    <div
      style={{
        height: "100%",
        overflowY: "auto",
        background: C.bg,
        fontFamily: "'Crimson Text', 'Georgia', serif",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Crimson+Text:ital,wght@0,400;0,600;0,700;1,400&display=swap');
        .et-section { border-bottom: 1px solid ${C.border}; padding: 10px 12px; }
        .et-section:last-child { border-bottom: none; }
        .et-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.14em; color: ${C.textDim}; margin-bottom: 6px; font-family: sans-serif; }
        .et-gold { color: ${C.accent}; text-shadow: 0 0 8px ${C.accentGlow}; }
        .et-crisis-pulse { animation: crisisPulse 2s ease-in-out infinite; }
        @keyframes crisisPulse { 0%,100% { opacity: 0.6; } 50% { opacity: 1; } }
        .et-scroll::-webkit-scrollbar { width: 3px; }
        .et-scroll::-webkit-scrollbar-thumb { background: ${C.borderLight}; border-radius: 3px; }
        .et-scroll::-webkit-scrollbar-track { background: transparent; }
      `}</style>

      {/* Header */}
      <div
        className="et-section"
        style={{ textAlign: "center", paddingTop: "16px", paddingBottom: "12px" }}
      >
        <div
          style={{
            fontSize: "8px",
            letterSpacing: "0.3em",
            color: C.textDim,
            textTransform: "uppercase",
            fontFamily: "sans-serif",
          }}
        >
          Solo RPG
        </div>
        {game.initialized ? (
          <>
            <div
              className="et-gold"
              style={{ fontSize: "16px", fontWeight: 700, marginTop: "4px" }}
            >
              {game.playerName}
            </div>
            {game.characterConcept && (
              <div
                style={{
                  fontSize: "11px",
                  color: C.textMuted,
                  fontStyle: "italic",
                  marginTop: "2px",
                }}
              >
                {game.characterConcept}
              </div>
            )}
            {game.settingGenre && (
              <div
                style={{
                  fontSize: "8px",
                  color: C.accentDim,
                  marginTop: "4px",
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  fontFamily: "sans-serif",
                }}
              >
                {GENRE_LABELS[game.settingGenre] || game.settingGenre}
              </div>
            )}
          </>
        ) : (
          <div
            style={{ fontSize: "11px", color: C.textDim, marginTop: "8px", fontStyle: "italic" }}
          >
            Creating your story...
          </div>
        )}
      </div>

      {/* Pre-init placeholder */}
      {!game.initialized && (
        <div className="et-section" style={{ textAlign: "center", padding: "32px 12px" }}>
          {/* biome-ignore lint/style/useConsistentCurlyBraces: unicode escape */}
          <div style={{ fontSize: "36px", opacity: 0.08 }}>{"\u2726"}</div>
          <div
            style={{
              fontSize: "10px",
              color: C.textDim,
              marginTop: "10px",
              lineHeight: 1.7,
              fontStyle: "italic",
            }}
          >
            Choose your world.
            <br />
            Shape your character.
            <br />
            Begin your tale.
          </div>
        </div>
      )}

      {game.initialized && (
        <>
          {/* Crisis / Game Over Banner */}
          {(game.crisisMode || game.gameOver) && (
            <div
              className="et-section et-crisis-pulse"
              style={{
                textAlign: "center",
                padding: "8px 12px",
                background: `${C.threat}15`,
                borderBottom: `1px solid ${C.threat}33`,
              }}
            >
              <div
                style={{
                  fontSize: "10px",
                  fontWeight: 700,
                  color: C.healthBright,
                  textTransform: "uppercase",
                  letterSpacing: "0.15em",
                  fontFamily: "sans-serif",
                }}
              >
                {game.gameOver
                  ? game.kidMode
                    ? "In Trouble"
                    : "Finale"
                  : game.kidMode
                    ? "In Trouble"
                    : "Crisis"}
              </div>
            </div>
          )}

          {/* Stats */}
          <div className="et-section">
            <div className="et-label">Attributes</div>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "0 4px" }}>
              <StatPip label="Edge" value={game.edge} />
              <StatPip label="Heart" value={game.heart} />
              <StatPip label="Iron" value={game.iron} />
              <StatPip label="Shadow" value={game.shadow} />
              <StatPip label="Wits" value={game.wits} />
            </div>
          </div>

          {/* Resources */}
          <div className="et-section">
            <ResourceBar
              label="Health"
              current={game.health}
              max={5}
              color={C.health}
              colorBright={C.healthBright}
              icon="\u2665"
            />
            <ResourceBar
              label="Spirit"
              current={game.spirit}
              max={5}
              color={C.spirit}
              colorBright={C.spiritBright}
              icon="\u25C6"
            />
            <ResourceBar
              label="Supply"
              current={game.supply}
              max={5}
              color={C.supply}
              colorBright={C.supplyBright}
              icon="\u25A0"
            />
            <MomentumTrack momentum={game.momentum} max={game.maxMomentum} />
            <ChaosGauge chaos={game.chaosFactor} />
          </div>

          {/* Location & Time */}
          <div className="et-section">
            <div className="et-label">Location</div>
            <div className="et-gold" style={{ fontSize: "13px", fontWeight: 600 }}>
              {game.currentLocation || "Unknown"}
            </div>
            {game.currentSceneContext && (
              <div
                style={{
                  fontSize: "10px",
                  color: C.textMuted,
                  marginTop: "3px",
                  fontStyle: "italic",
                  lineHeight: 1.4,
                }}
              >
                {game.currentSceneContext}
              </div>
            )}
            {game.timeOfDay && (
              <div
                style={{
                  fontSize: "9px",
                  color: C.accentDim,
                  marginTop: "4px",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  fontFamily: "sans-serif",
                }}
              >
                {TIME_LABELS[game.timeOfDay] || game.timeOfDay}
              </div>
            )}
          </div>

          {/* Story Arc */}
          {game.storyBlueprint && (
            <div className="et-section">
              <StoryArc story={game.storyBlueprint} />
            </div>
          )}

          {/* Clocks */}
          {game.clocks.length > 0 && (
            <div className="et-section">
              <div className="et-label">Clocks</div>
              {game.clocks.map((clock) => (
                <ClockDisplay key={clock.id || clock.name} clock={clock} />
              ))}
            </div>
          )}

          {/* NPCs */}
          {(() => {
            const active = game.npcs.filter((n) => n.status === "active");
            const background = game.npcs.filter((n) => n.status === "background");
            if (active.length === 0 && background.length === 0) return null;
            return (
              <div className="et-section">
                <div className="et-label">Characters</div>
                {active.map((npc) => (
                  <NpcCard key={npc.id} npc={npc} />
                ))}
                {background.length > 0 && (
                  <>
                    <div
                      style={{
                        fontSize: "8px",
                        color: C.textDim,
                        textTransform: "uppercase",
                        letterSpacing: "0.1em",
                        margin: "6px 0 4px",
                        fontFamily: "sans-serif",
                      }}
                    >
                      Known
                    </div>
                    {background.map((npc) => (
                      <div
                        key={npc.id}
                        style={{
                          fontSize: "10px",
                          color: C.textMuted,
                          marginBottom: "2px",
                          paddingLeft: "8px",
                          borderLeft: `1px solid ${C.border}`,
                        }}
                      >
                        {npc.name}
                        <span style={{ fontSize: "8px", color: C.textDim, marginLeft: "4px" }}>
                          {npc.disposition}
                        </span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            );
          })()}

          {/* Session Log */}
          {game.sessionLog.length > 0 && (
            <div className="et-section">
              <div className="et-label">Chronicle</div>
              {game.sessionLog.slice(-5).map((entry, i) => (
                <div
                  key={i}
                  style={{
                    fontSize: "10px",
                    color: C.textDim,
                    fontStyle: "italic",
                    lineHeight: 1.5,
                    marginBottom: "4px",
                    paddingLeft: "8px",
                    borderLeft: `1px solid ${C.border}`,
                  }}
                >
                  <span style={{ color: C.textMuted, fontStyle: "normal", fontSize: "8px" }}>
                    {entry.scene}.{" "}
                  </span>
                  {entry.summary}
                </div>
              ))}
            </div>
          )}

          {/* Scene Counter */}
          <div className="et-section" style={{ textAlign: "center", padding: "8px 12px" }}>
            <span
              style={{
                fontSize: "8px",
                color: C.textDim,
                letterSpacing: "0.15em",
                fontFamily: "sans-serif",
              }}
            >
              {game.kidMode ? "\u2726 " : ""}SCENE {game.sceneCount}
              {game.kidMode ? " \u2726" : ""}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// ── App ──────────────────────────────────────────────────────────────────────

function SoloRPGApp() {
  const [game, setGame] = useState<GameState>(structuredClone(INITIAL));

  // Load saved game state from KV on page load
  useEffect(() => {
    fetch(`${location.origin}${location.pathname}kv?key=${encodeURIComponent("save:game")}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((saved: GameState | null) => {
        if (saved) setGame((prev) => ({ ...prev, ...saved }));
      })
      .catch(() => {});
  }, []);

  const mergeState = (result: Partial<GameState>, prev: GameState): GameState => ({
    ...prev,
    ...Object.fromEntries(Object.entries(result).filter(([, v]) => v !== undefined)),
  });

  useToolResult<SoloRpgToolResults["setup_character"]>("setup_character", (result) => {
    if (result.success) setGame((prev) => mergeState(result, prev));
  });

  useToolResult<SoloRpgToolResults["update_state"]>("update_state", (result) => {
    if (result.success) setGame((prev) => mergeState(result, prev));
  });

  useToolResult<SoloRpgToolResults["action_roll"]>("action_roll", (result) => {
    setGame((prev) => ({
      ...prev,
      health: result.currentHealth,
      spirit: result.currentSpirit,
      supply: result.currentSupply,
      momentum: result.currentMomentum,
      chaosFactor: result.chaosFactor,
      crisisMode: result.crisisMode,
      gameOver: result.gameOver,
      sceneCount: result.sceneCount,
    }));
  });

  useToolResult<SoloRpgToolResults["burn_momentum"]>("burn_momentum", (result) => {
    if ("burned" in result && result.burned) {
      setGame((prev) => ({ ...prev, momentum: result.newMomentum }));
    }
  });

  useToolResult<SoloRpgToolResults["load_game"]>("load_game", (result) => {
    if ("loaded" in result && result.loaded) {
      setGame((prev) => mergeState(result, prev));
    }
  });

  return (
    <StartScreen
      icon={
        <span style={{ fontSize: "28px", color: C.accent }}>
          {/* biome-ignore lint/style/useConsistentCurlyBraces: unicode escape */}
          {"\u2726"}
        </span>
      }
      title="Solo RPG"
      subtitle="A Narrative Solo-RPG Engine"
      buttonText="Begin Your Story"
    >
      <SidebarLayout sidebar={<Sidebar game={game} />} sidebarWidth="260px" sidebarPosition="right">
        <ChatView />
      </SidebarLayout>
    </StartScreen>
  );
}

const SESSION_KEY = "solo-rpg:sessionId";
const savedSessionId = localStorage.getItem(SESSION_KEY);

defineClient({
  component: SoloRPGApp,
  theme: {
    bg: C.bg,
    primary: C.accent,
    text: C.text,
    surface: C.surface,
    border: C.border,
  },
  onSessionId: (id: string) => localStorage.setItem(SESSION_KEY, id),
  ...(savedSessionId ? { resumeSessionId: savedSessionId } : {}),
});
