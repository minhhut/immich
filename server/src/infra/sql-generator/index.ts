#!/usr/bin/env node
import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GENERATE_SQL_KEY, GenerateSqlQueries } from 'src/decorators';
import { ISystemConfigRepository } from 'src/domain/repositories/system-config.repository';
import { databaseConfig } from 'src/infra/database.config';
import { databaseEntities } from 'src/infra/entities';
import { AccessRepository } from 'src/infra/repositories/access.repository';
import { AlbumRepository } from 'src/infra/repositories/album.repository';
import { ApiKeyRepository } from 'src/infra/repositories/api-key.repository';
import { AssetRepository } from 'src/infra/repositories/asset.repository';
import { AuditRepository } from 'src/infra/repositories/audit.repository';
import { LibraryRepository } from 'src/infra/repositories/library.repository';
import { MoveRepository } from 'src/infra/repositories/move.repository';
import { PartnerRepository } from 'src/infra/repositories/partner.repository';
import { PersonRepository } from 'src/infra/repositories/person.repository';
import { SearchRepository } from 'src/infra/repositories/search.repository';
import { SharedLinkRepository } from 'src/infra/repositories/shared-link.repository';
import { SystemConfigRepository } from 'src/infra/repositories/system-config.repository';
import { SystemMetadataRepository } from 'src/infra/repositories/system-metadata.repository';
import { TagRepository } from 'src/infra/repositories/tag.repository';
import { UserTokenRepository } from 'src/infra/repositories/user-token.repository';
import { UserRepository } from 'src/infra/repositories/user.repository';
import { SqlLogger } from 'src/infra/sql-generator/sql.logger';

const reflector = new Reflector();
const repositories = [
  AccessRepository,
  AlbumRepository,
  ApiKeyRepository,
  AssetRepository,
  AuditRepository,
  LibraryRepository,
  MoveRepository,
  PartnerRepository,
  PersonRepository,
  SharedLinkRepository,
  SearchRepository,
  SystemConfigRepository,
  SystemMetadataRepository,
  TagRepository,
  UserTokenRepository,
  UserRepository,
];

type Repository = (typeof repositories)[0];
type SqlGeneratorOptions = { targetDir: string };

class SqlGenerator {
  private app: INestApplication | null = null;
  private sqlLogger = new SqlLogger();
  private results: Record<string, string[]> = {};

  constructor(private options: SqlGeneratorOptions) {}

  async run() {
    try {
      await this.setup();
      for (const Repository of repositories) {
        await this.process(Repository);
      }
      await this.write();
      this.stats();
    } finally {
      await this.close();
    }
  }

  private async setup() {
    await rm(this.options.targetDir, { force: true, recursive: true });
    await mkdir(this.options.targetDir);

    const moduleFixture = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          ...databaseConfig,
          entities: databaseEntities,
          logging: ['query'],
          logger: this.sqlLogger,
        }),
        TypeOrmModule.forFeature(databaseEntities),
      ],
      providers: [{ provide: ISystemConfigRepository, useClass: SystemConfigRepository }, ...repositories],
    }).compile();

    this.app = await moduleFixture.createNestApplication().init();
  }

  async process(Repository: Repository) {
    if (!this.app) {
      throw new Error('Not initialized');
    }

    const data: string[] = [`-- NOTE: This file is auto generated by ./sql-generator`];
    const instance = this.app.get<Repository>(Repository);

    // normal repositories
    data.push(...(await this.runTargets(instance, `${Repository.name}`)));

    // nested repositories
    if (Repository.name === AccessRepository.name) {
      for (const key of Object.keys(instance)) {
        const subInstance = (instance as any)[key];
        data.push(...(await this.runTargets(subInstance, `${Repository.name}.${key}`)));
      }
    }

    this.results[Repository.name] = data;
  }

  private async runTargets(instance: any, label: string) {
    const data: string[] = [];

    for (const key of this.getPropertyNames(instance)) {
      const target = instance[key];
      if (!(target instanceof Function)) {
        continue;
      }

      const queries = reflector.get<GenerateSqlQueries[] | undefined>(GENERATE_SQL_KEY, target);
      if (!queries) {
        continue;
      }

      // empty decorator implies calling with no arguments
      if (queries.length === 0) {
        queries.push({ params: [] });
      }

      for (const { name, params } of queries) {
        let queryLabel = `${label}.${key}`;
        if (name) {
          queryLabel += ` (${name})`;
        }

        this.sqlLogger.clear();

        // errors still generate sql, which is all we care about
        await target.apply(instance, params).catch((error: Error) => console.error(`${queryLabel} error: ${error}`));

        if (this.sqlLogger.queries.length === 0) {
          console.warn(`No queries recorded for ${queryLabel}`);
          continue;
        }

        data.push([`-- ${queryLabel}`, ...this.sqlLogger.queries].join('\n'));
      }
    }

    return data;
  }

  private async write() {
    for (const [repoName, data] of Object.entries(this.results)) {
      const filename = repoName.replaceAll(/[A-Z]/g, (letter) => `.${letter.toLowerCase()}`).replace('.', '');
      const file = join(this.options.targetDir, `${filename}.sql`);
      await writeFile(file, data.join('\n\n') + '\n');
    }
  }

  private stats() {
    console.log(`Wrote ${Object.keys(this.results).length} files`);
    console.log(`Generated ${Object.values(this.results).flat().length} queries`);
  }

  private async close() {
    if (this.app) {
      await this.app.close();
    }
  }

  private getPropertyNames(instance: any): string[] {
    return Object.getOwnPropertyNames(Object.getPrototypeOf(instance)) as any[];
  }
}

new SqlGenerator({ targetDir: './src/infra/sql' })
  .run()
  .then(() => {
    console.log('Done');
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    console.log('Something went wrong');
    process.exit(1);
  });
