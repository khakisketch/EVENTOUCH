"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import styles from "./landing-sections.module.css";

export type FlowScene = {
  id: string;
  phase: string;
  title: string;
  body: string;
  screens: string;
  stage: ReactNode;
};

/**
 * One event in three moments. The active moment advances on its own while it
 * is on screen, stops when the reader hovers, focuses or taps a moment, and
 * never moves for people who asked for reduced motion.
 */
export default function LandingFlow({ scenes }: { scenes: readonly FlowScene[] }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [inView, setInView] = useState(false);
  const [motion, setMotion] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    setMotion(!window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const el = root.current;
    if (!el || !("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const running = motion && inView && !paused;
  const go = (next: number, focus = false) => {
    const wrapped = (next + scenes.length) % scenes.length;
    setIndex(wrapped);
    if (focus) tabs.current[wrapped]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
    const back = event.key === "ArrowUp" || event.key === "ArrowLeft";
    if (!forward && !back && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    setPaused(true);
    if (event.key === "Home") go(0, true);
    else if (event.key === "End") go(scenes.length - 1, true);
    else go(index + (forward ? 1 : -1), true);
  };

  return (
    <div
      ref={root}
      className={styles.flow}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className={styles.flowTabs} role="tablist" aria-orientation="vertical" aria-label="행사의 세 시점" onKeyDown={onKeyDown}>
        {scenes.map((scene, i) => {
          const active = i === index;
          return (
            <button
              key={scene.id}
              ref={(node) => { tabs.current[i] = node; }}
              type="button"
              role="tab"
              id={`flow-tab-${scene.id}`}
              aria-selected={active}
              aria-controls={`flow-panel-${scene.id}`}
              tabIndex={active ? 0 : -1}
              className={styles.flowTab}
              onClick={() => { setPaused(true); setIndex(i); }}
            >
              <span className={styles.flowNum} aria-hidden="true">0{i + 1}</span>
              <span className={styles.flowText}>
                <em>{scene.phase}</em>
                <strong>{scene.title}</strong>
                <span className={styles.flowMore}>
                  <span className={styles.flowMoreInner}>
                    <span>{scene.body}</span>
                    <small>{scene.screens}</small>
                  </span>
                </span>
              </span>
              <i className={styles.flowBar} aria-hidden="true">
                <b
                  key={`${i}-${active}-${running}`}
                  data-running={active && running ? "true" : "false"}
                  data-done={active && !running && !motion ? "true" : "false"}
                  onAnimationEnd={() => go(index + 1)}
                />
              </i>
            </button>
          );
        })}
      </div>
      <div
        className={styles.flowStage}
        role="tabpanel"
        id={`flow-panel-${scenes[index].id}`}
        aria-labelledby={`flow-tab-${scenes[index].id}`}
      >
        <div key={scenes[index].id} className={styles.flowScene}>{scenes[index].stage}</div>
      </div>
      {/* One-column layouts: the tabs shrink to a row, so the moment's text sits here. */}
      <p className={styles.flowCaption}>
        <em>{scenes[index].phase}</em>
        <strong>{scenes[index].title}</strong>
        <span>{scenes[index].body}</span>
        <small>{scenes[index].screens}</small>
      </p>
    </div>
  );
}
