import { logger } from '../../../logger';
import { Http } from '../../../util/http';
import { regEx } from '../../../util/regex';
import { ensureTrailingSlash } from '../../../util/url';
import * as ivyVersioning from '../../versioning/ivy';
import { compare } from '../../versioning/maven/compare';
import { MAVEN_REPO } from '../maven/common';
import { downloadHttpProtocol } from '../maven/util';
import { SbtPackageDatasource } from '../sbt-package';
import { extractPageLinks, getLatestVersion } from '../sbt-package/util';
import type {
  GetReleasesConfig,
  RegistryStrategy,
  ReleaseResult,
} from '../types';

export const SBT_PLUGINS_REPO =
  'https://repo.scala-sbt.org/scalasbt/sbt-plugin-releases';

export const defaultRegistryUrls = [SBT_PLUGINS_REPO, MAVEN_REPO];

export class SbtPluginDatasource extends SbtPackageDatasource {
  static override readonly id = 'sbt-plugin';

  override readonly defaultRegistryUrls = defaultRegistryUrls;

  override readonly registryStrategy: RegistryStrategy = 'merge';

  override readonly defaultVersioning = ivyVersioning.id;

  override readonly sourceUrlSupport = 'package';
  override readonly sourceUrlNote =
    'The source URL is determined from the `scm` tags in the results.';

  constructor() {
    super(SbtPluginDatasource.id);
    this.http = new Http('sbt');
  }

  async resolvePluginReleases(
    rootUrl: string,
    artifact: string,
    scalaVersion: string,
  ): Promise<string[] | null> {
    const searchRoot = `${rootUrl}/${artifact}`;
    const hrefFilterMap = (href: string): string | null => {
      if (href.startsWith('.')) {
        return null;
      }

      return href;
    };
    const res = await downloadHttpProtocol(
      this.http,
      ensureTrailingSlash(searchRoot),
    );
    if (res) {
      const releases: string[] = [];
      const scalaVersionItems = extractPageLinks(res.body, hrefFilterMap);
      const scalaVersions = scalaVersionItems.map((x) =>
        x.replace(regEx(/^scala_/), ''),
      );
      const searchVersions = scalaVersions.includes(scalaVersion)
        ? [scalaVersion]
        : scalaVersions;
      for (const searchVersion of searchVersions) {
        const searchSubRoot = `${searchRoot}/scala_${searchVersion}`;
        const subRootRes = await downloadHttpProtocol(
          this.http,
          ensureTrailingSlash(searchSubRoot),
        );
        if (subRootRes) {
          const { body: subRootContent } = subRootRes;
          const sbtVersionItems = extractPageLinks(
            subRootContent,
            hrefFilterMap,
          );
          for (const sbtItem of sbtVersionItems) {
            const releasesRoot = `${searchSubRoot}/${sbtItem}`;
            const releaseIndexRes = await downloadHttpProtocol(
              this.http,
              ensureTrailingSlash(releasesRoot),
            );
            if (releaseIndexRes) {
              const { body: releasesIndexContent } = releaseIndexRes;
              const releasesParsed = extractPageLinks(
                releasesIndexContent,
                hrefFilterMap,
              );
              releasesParsed.forEach((x) => releases.push(x));
            }
          }
        }
      }
      if (releases.length) {
        return [...new Set(releases)].sort(compare);
      }
    }
    return null;
  }

  override async getReleases({
    packageName,
    registryUrl,
  }: GetReleasesConfig): Promise<ReleaseResult | null> {
    // istanbul ignore if
    if (!registryUrl) {
      return null;
    }

    const [groupId, artifactId] = packageName.split(':');
    const groupIdSplit = groupId.split('.');
    const artifactIdSplit = artifactId.split('_');
    const [artifact, scalaVersion] = artifactIdSplit;

    const repoRoot = ensureTrailingSlash(registryUrl);
    const searchRoots: string[] = [];
    // Optimize lookup order
    if (!registryUrl.startsWith(MAVEN_REPO)) {
      searchRoots.push(`${repoRoot}${groupIdSplit.join('.')}`);
    }
    searchRoots.push(`${repoRoot}${groupIdSplit.join('/')}`);

    for (let idx = 0; idx < searchRoots.length; idx += 1) {
      const searchRoot = searchRoots[idx];
      let versions = await this.resolvePluginReleases(
        searchRoot,
        artifact,
        scalaVersion,
      );
      let urls = {};

      if (!versions?.length) {
        const artifactSubdirs = await this.getArtifactSubdirs(
          searchRoot,
          artifact,
          scalaVersion,
        );
        versions = await this.getPackageReleases(searchRoot, artifactSubdirs);
        const latestVersion = getLatestVersion(versions);
        urls = await this.getUrls(searchRoot, artifactSubdirs, latestVersion);
      }

      const dependencyUrl = `${searchRoot}/${artifact}`;

      logger.trace({ dependency: packageName, versions }, `Package versions`);
      if (versions) {
        return {
          ...urls,
          dependencyUrl,
          releases: versions.map((v) => ({ version: v })),
        };
      }
    }

    logger.debug(
      `No versions found for ${packageName} in ${searchRoots.length} repositories`,
    );
    return null;
  }
}
