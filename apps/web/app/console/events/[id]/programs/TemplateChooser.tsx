"use client";

// 이벤트 만들기: choose a template, then the existing flow for that type
// opens. Module types open the existing create dialog with the type
// preselected; draw types open their existing settings on the draws screen.
// Only types that exist today get a tile.

import ConsoleDialog from "../../../console-ui/ConsoleDialog";
import ProductLink from "../../../../ui/ProductLink";
import { EVENT_TEMPLATES, TEMPLATE_GROUPS, type EventTemplate } from "../../../../../lib/participation-events";
import ProgramTypeIcon from "./ProgramIcons";
import styles from "./programs.module.css";

type Props = {
  eventId: string;
  closeHref: (target: string) => string;
  /** Types switched off in 행사 설정; their module tiles are disabled with the reason. */
  isTypeEnabled: (type: string) => boolean;
  /** Draw-side tiles need the draw/poll feature on and permission to write draws. */
  isDrawEnabled: (featureKey: "draw" | "poll") => boolean;
  disabled: boolean;
  onPickModule: (type: string) => void;
};

function drawFeatureKey(template: EventTemplate): "draw" | "poll" {
  return template.id === "vote" ? "poll" : "draw";
}

export function TemplateGroups({ eventId, closeHref, isTypeEnabled, isDrawEnabled, disabled, onPickModule }: Props) {
  return (
    <div className={styles.templateGroups}>
      {TEMPLATE_GROUPS.map((group) => (
        <section key={group.key} className={styles.templateGroup} aria-labelledby={`template-group-${group.key}`}>
          <h3 className={styles.templateGroupTitle} id={`template-group-${group.key}`}>{group.label}<span>{group.hint}</span></h3>
          <ul>
            {EVENT_TEMPLATES.filter((template) => template.group === group.key).map((template) => {
              const off = template.action === "module" ? !isTypeEnabled(template.moduleType) : !isDrawEnabled(drawFeatureKey(template));
              const body = (
                <>
                  <ProgramTypeIcon type={template.icon} />
                  <span className={styles.templateText}>
                    <b>{template.label}</b>
                    <span>{off ? "행사 설정에서 이 기능을 켜면 만들 수 있습니다." : template.description}</span>
                  </span>
                </>
              );
              return (
                <li key={template.id}>
                  {template.action === "module" ? (
                    <button type="button" className={styles.templateTile} disabled={disabled || off} data-template={template.id} onClick={() => onPickModule(template.moduleType)}>{body}</button>
                  ) : off ? (
                    <span className={styles.templateTile} aria-disabled="true" data-template={template.id}>{body}</span>
                  ) : (
                    <ProductLink className={styles.templateTile} data-template={template.id}
                      href={closeHref(`/console/events/${encodeURIComponent(eventId)}/draws${template.query ? `?${template.query}` : ""}${template.hash}`)}>{body}</ProductLink>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <p className={styles.templateHint}>기획안 게임은 템플릿으로 추가됩니다.</p>
    </div>
  );
}

export default function TemplateChooser(props: Props & { onClose: () => void }) {
  return (
    <ConsoleDialog title="이벤트 만들기" titleId="template-dialog-title" wide onClose={props.onClose}
      description="만들 이벤트의 종류를 고르면 해당 설정이 열립니다.">
      <TemplateGroups {...props} />
    </ConsoleDialog>
  );
}
