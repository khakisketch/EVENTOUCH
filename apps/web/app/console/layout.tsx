import ConsoleShell from "./ConsoleShell";
import { ConsoleDraftGuardProvider } from "./console-draft-guard";

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return <ConsoleDraftGuardProvider><ConsoleShell>{children}</ConsoleShell></ConsoleDraftGuardProvider>;
}
