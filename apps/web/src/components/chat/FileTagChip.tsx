import type { EnvironmentId } from "@t3tools/contracts";
import { ContextChipLabel } from "../ContextChip";
import { WorkspaceEntryIcon } from "./WorkspaceEntryIcon";

export function FileTagChipContent(props: {
  path: string;
  label: string;
  theme: "light" | "dark";
  environmentId?: EnvironmentId | null | undefined;
  cwd?: string | undefined;
  iconId?: string | undefined;
}) {
  const icon = (
    <WorkspaceEntryIcon
      path={props.path}
      environmentId={props.environmentId}
      cwd={props.cwd}
      theme={props.theme}
    />
  );
  return (
    <>
      {props.iconId ? (
        <span id={props.iconId} className="inline-flex shrink-0">
          {icon}
        </span>
      ) : (
        icon
      )}
      <ContextChipLabel>{props.label}</ContextChipLabel>
    </>
  );
}
