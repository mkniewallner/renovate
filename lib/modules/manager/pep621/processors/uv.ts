import is from '@sindresorhus/is';
import { quote } from 'shlex';
import { TEMPORARY_ERROR } from '../../../../constants/error-messages';
import { logger } from '../../../../logger';
import { exec } from '../../../../util/exec';
import type { ExecOptions, ToolConstraint } from '../../../../util/exec/types';
import { findLocalSiblingOrParent, getSiblingFileName, readLocalFile } from '../../../../util/fs';
import { Result } from '../../../../util/result';
import type {
  PackageDependency,
  UpdateArtifact,
  UpdateArtifactsResult,
  Upgrade,
} from '../../types';
import { UvLockfileSchema, type PyProject } from '../schema';
import { depTypes, parseDependencyList } from '../utils';
import type { PyProjectProcessor } from './types';

const uvUpdateCMD = 'uv update --no-sync --update-eager';

export class UvProcessor implements PyProjectProcessor {
  process(project: PyProject, deps: PackageDependency[]): PackageDependency[] {
    const uv = project.tool?.uv;
    if (is.nullOrUndefined(uv)) {
      return deps;
    }

    deps.push(...parseDependencyList(depTypes.uvDevDependencies, uv['dev-dependencies']));

    return deps;
  }

  async extractLockedVersions(
    project: PyProject,
    deps: PackageDependency[],
    packageFile: string,
  ): Promise<PackageDependency[]> {
    const lockFileName = getSiblingFileName(packageFile, 'uv.lock');
    const lockFileContent = await readLocalFile(lockFileName, 'utf8');
    if (lockFileContent) {
      const lockFileMapping = Result.parse(
        lockFileContent,
        UvLockfileSchema.transform(({ lock }) => lock),
      ).unwrapOrElse({});

      for (const dep of deps) {
        const packageName = dep.packageName;
        if (packageName && packageName in lockFileMapping) {
          dep.lockedVersion = lockFileMapping[packageName];
        }
      }
    }

    return Promise.resolve(deps);
  }

  async updateArtifacts(
    updateArtifact: UpdateArtifact,
    project: PyProject,
  ): Promise<UpdateArtifactsResult[] | null> {
    const { config, updatedDeps, packageFileName } = updateArtifact;

    // abort if no lockfile is defined
    const lockFileName = getSiblingFileName(packageFileName, 'uv.lock');
    try {
      const existingLockFileContent = await readLocalFile(lockFileName, 'utf8');
      if (is.nullOrUndefined(existingLockFileContent)) {
        logger.debug('No uv.lock found');
        return null;
      }

      const pythonConstraint: ToolConstraint = {
        toolName: 'python',
        constraint:
          config.constraints?.python ?? project.project?.['requires-python'],
      };

      const execOptions: ExecOptions = {
        cwdFile: packageFileName,
        docker: {},
        userConfiguredEnv: config.env,
        toolConstraints: [pythonConstraint],
      };

      await exec(generateCMDs(updatedDeps), execOptions);

      // check for changes
      const fileChanges: UpdateArtifactsResult[] = [];
      const newLockContent = await readLocalFile(lockFileName, 'utf8');
      const isLockFileChanged = existingLockFileContent !== newLockContent;
      if (isLockFileChanged) {
        fileChanges.push({
          file: {
            type: 'addition',
            path: lockFileName,
            contents: newLockContent,
          },
        });
      } else {
        logger.debug('uv.lock is unchanged');
      }

      return fileChanges.length ? fileChanges : null;
    } catch (err) {
      // istanbul ignore if
      if (err.message === TEMPORARY_ERROR) {
        throw err;
      }
      logger.debug({ err }, 'Failed to update uv lock file');
      return [
        {
          artifactError: {
            lockFile: lockFileName,
            stderr: err.message,
          },
        },
      ];
    }
  }
}

function generateCMDs(updatedDeps: Upgrade[]): string[] {
  const cmds: string[] = [];
  const packagesByCMD: Record<string, string[]> = {};
  for (const dep of updatedDeps) {
    switch (dep.depType) {
      case depTypes.optionalDependencies: {
        const [group, name] = dep.depName!.split('/');
        addPackageToCMDRecord(
          packagesByCMD,
          `${uvUpdateCMD} --extra ${quote(group)}`,
          name,
        );
        break;
      }
      case depTypes.uvDevDependencies: {
        addPackageToCMDRecord(
          packagesByCMD,
          `${uvUpdateCMD} --dev`,
          dep.depName!,
        );
        break;
      }
      case depTypes.buildSystemRequires:
        // build requirements are not locked in the lock files, no need to update.
        break;
      default: {
        addPackageToCMDRecord(packagesByCMD, uvUpdateCMD, dep.packageName!);
      }
    }
  }

  for (const commandPrefix in packagesByCMD) {
    const packageList = packagesByCMD[commandPrefix].map(quote).join(' ');
    const cmd = `${commandPrefix} ${packageList}`;
    cmds.push(cmd);
  }

  return cmds;
}

function addPackageToCMDRecord(
  packagesByCMD: Record<string, string[]>,
  commandPrefix: string,
  packageName: string,
): void {
  if (is.nullOrUndefined(packagesByCMD[commandPrefix])) {
    packagesByCMD[commandPrefix] = [];
  }
  packagesByCMD[commandPrefix].push(packageName);
}
