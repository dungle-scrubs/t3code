import { SourceControlProviderKind, type RepositoryIdentity } from "@t3tools/contracts";

const GITHUB_HOST = "github.com";

function repositorySegments(pathname: string): readonly [string, string] | null {
  let path = pathname;
  while (path.endsWith("/")) path = path.slice(0, -1);
  if (path.endsWith(".git")) path = path.slice(0, -4);
  while (path.endsWith("/")) path = path.slice(0, -1);
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 2) return null;
  const owner = segments[0];
  const repo = segments[1];
  if (!owner || !repo) return null;
  return [owner, repo];
}

export function githubIssuesUrl(identity: RepositoryIdentity | null | undefined): string | null {
  if (!identity) return null;
  if (
    identity.provider !== undefined &&
    identity.provider !== SourceControlProviderKind.make("github")
  ) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(identity.webUrl ?? `https://${identity.canonicalKey}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (identity.provider === undefined && url.hostname !== GITHUB_HOST) return null;

  const segments = repositorySegments(url.pathname);
  if (!segments) return null;
  return `${url.origin}/${segments[0]}/${segments[1]}/issues`;
}
