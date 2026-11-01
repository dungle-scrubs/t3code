import { SourceControlProviderKind, type RepositoryIdentity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { githubIssuesUrl } from "./keyboardHintCommands";

const locator = {
  source: "git-remote" as const,
  remoteName: "origin",
  remoteUrl: "https://user:secret@github.com/from/locator.git",
};

function identity(
  patch: Partial<RepositoryIdentity> & Pick<RepositoryIdentity, "canonicalKey">,
): RepositoryIdentity {
  return { locator, ...patch };
}

describe("githubIssuesUrl", () => {
  it("returns null without an identity", () => {
    expect(githubIssuesUrl(null)).toBeNull();
    expect(githubIssuesUrl(undefined)).toBeNull();
  });

  it("prefers the web URL and otherwise uses the canonical key", () => {
    expect(
      githubIssuesUrl(
        identity({
          canonicalKey: "github.com/from/key",
          webUrl: "https://github.com/acme/web",
        }),
      ),
    ).toBe("https://github.com/acme/web/issues");
    expect(githubIssuesUrl(identity({ canonicalKey: "github.com/acme/web.git" }))).toBe(
      "https://github.com/acme/web/issues",
    );
    expect(githubIssuesUrl(identity({ canonicalKey: "github.com/acme/web" }))).toBe(
      "https://github.com/acme/web/issues",
    );
  });

  it("trims a trailing slash and .git and drops the query and hash", () => {
    expect(
      githubIssuesUrl(
        identity({
          canonicalKey: "github.com/acme/web",
          webUrl: "https://GitHub.com/Acme/Web.git/?tab=readme#section",
        }),
      ),
    ).toBe("https://github.com/Acme/Web/issues");
    expect(
      githubIssuesUrl(
        identity({
          canonicalKey: "github.com/acme/web",
          webUrl: "http://github.com/acme/web/",
        }),
      ),
    ).toBe("http://github.com/acme/web/issues");
  });

  it("allows an enterprise host only when the provider is github", () => {
    const enterprise = {
      canonicalKey: "git.example.com/acme/web",
      webUrl: "http://git.example.com:8443/acme/web.git",
    };
    expect(
      githubIssuesUrl(
        identity({ ...enterprise, provider: SourceControlProviderKind.make("github") }),
      ),
    ).toBe("http://git.example.com:8443/acme/web/issues");
    expect(githubIssuesUrl(identity(enterprise))).toBeNull();
    expect(
      githubIssuesUrl(
        identity({
          canonicalKey: "github.example.com/acme/web",
          webUrl: "https://github.example.com/acme/web",
        }),
      ),
    ).toBeNull();
  });

  it("rejects other providers, credentials, and paths that are not owner/repo", () => {
    expect(
      githubIssuesUrl(
        identity({
          canonicalKey: "github.com/acme/web",
          provider: SourceControlProviderKind.make("gitlab"),
          webUrl: "https://github.com/acme/web",
        }),
      ),
    ).toBeNull();
    expect(
      githubIssuesUrl(
        identity({
          canonicalKey: "github.com/acme/web",
          webUrl: "https://user:token@github.com/acme/web",
        }),
      ),
    ).toBeNull();
    expect(
      githubIssuesUrl(identity({ canonicalKey: "user:token@github.com/acme/web" })),
    ).toBeNull();
    expect(
      githubIssuesUrl(
        identity({
          canonicalKey: "gitlab.com/acme/web",
        }),
      ),
    ).toBeNull();
    expect(
      githubIssuesUrl(
        identity({
          canonicalKey: "github.com/acme/web",
          webUrl: "https://www.github.com/acme/web",
        }),
      ),
    ).toBeNull();
    expect(
      githubIssuesUrl(
        identity({
          canonicalKey: "github.com/acme/web",
          webUrl: "https://github.com/acme",
        }),
      ),
    ).toBeNull();
    expect(
      githubIssuesUrl(
        identity({
          canonicalKey: "github.com/acme/web",
          webUrl: "https://github.com/acme/web/issues",
        }),
      ),
    ).toBeNull();
    expect(
      githubIssuesUrl(
        identity({
          canonicalKey: "github.com/acme/web",
          webUrl: "git://github.com/acme/web",
        }),
      ),
    ).toBeNull();
    expect(
      githubIssuesUrl(
        identity({
          canonicalKey: "github.com/acme/web",
          webUrl: "not a url",
        }),
      ),
    ).toBeNull();
  });
});
