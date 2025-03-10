/* eslint-disable @typescript-eslint/ban-types */
import fs from 'fs';
import path from 'path';

import * as Sentry from '@sentry/node';
import bodyParser from 'body-parser';
import clear from 'clear';
import cookieParser from 'cookie-parser';
import debug from 'debug';
import * as express from 'express';
import { Router } from 'express';
import importFresh from 'import-fresh';
import morgan from 'morgan';
import { Tele } from 'nc-help';
import NcToolGui from 'nc-lib-gui';
import requestIp from 'request-ip';
import { v4 as uuidv4 } from 'uuid';

import { NcConfig } from '../../interface/config';
import Migrator from '../migrator/SqlMigrator/lib/KnexMigrator';
import NcConfigFactory from '../utils/NcConfigFactory';

import NcProjectBuilderCE from './NcProjectBuilder';
import NcProjectBuilderEE from './NcProjectBuilderEE';
import { GqlApiBuilder } from './gql/GqlApiBuilder';
import NcMetaIO from './meta/NcMetaIO';
import NcMetaImplCE from './meta/NcMetaIOImpl';
import NcMetaImplEE from './meta/NcMetaIOImplEE';
import NcMetaMgrCE from './meta/NcMetaMgr';
import NcMetaMgrEE from './meta/NcMetaMgrEE';
import { RestApiBuilder } from './rest/RestApiBuilder';
import RestAuthCtrlCE from './rest/RestAuthCtrl';
import RestAuthCtrlEE from './rest/RestAuthCtrlEE';
import mkdirp from 'mkdirp';
import MetaAPILogger from './meta/MetaAPILogger';
import NcUpgrader from './upgrader/NcUpgrader';

const log = debug('nc:app');
require('dotenv').config();

const NcProjectBuilder = process.env.EE
  ? NcProjectBuilderEE
  : NcProjectBuilderCE;

export default class Noco {
  private static _this: Noco;

  public static get dashboardUrl(): string {
    let siteUrl = `http://localhost:${process.env.PORT || 8080}`;
    // if (Noco._this?.config?.envs?.[Noco._this?.env]?.publicUrl) {
    //   siteUrl = Noco._this?.config?.envs?.[Noco._this?.env]?.publicUrl;
    // }
    if (Noco._this?.config?.envs?.['_noco']?.publicUrl) {
      siteUrl = Noco._this?.config?.envs?.['_noco']?.publicUrl;
    }

    return `${siteUrl}${Noco._this?.config?.dashboardPath}`;
  }

  public static async init(args?: {
    progressCallback?: Function;
    registerRoutes?: Function;
    registerGql?: Function;
    registerContext?: Function;
    afterMetaMigrationInit?: Function;
  }): Promise<Router> {
    if (Noco._this) {
      return Noco._this.router;
    }
    Noco._this = new Noco();
    return Noco._this.init(args);
  }

  public readonly router: express.Router;
  public readonly projectRouter: express.Router;
  public readonly ncMeta: NcMetaIO;
  public readonly metaMgr: NcMetaMgrEE | NcMetaMgrCE;
  public env: string;

  public projectBuilders: Array<NcProjectBuilderCE | NcProjectBuilderEE> = [];
  private apiBuilders: Array<RestApiBuilder | GqlApiBuilder> = [];
  private ncToolApi;
  private config: NcConfig;
  private requestContext: any;

  private io: any;
  // @ts-ignore
  private socketClient: any;

  constructor() {
    process.env.PORT = process.env.PORT || '8080';
    // todo: move
    process.env.NC_VERSION = '0011043';

    this.router = express.Router();
    this.projectRouter = express.Router();

    /* prepare config */
    this.config = NcConfigFactory.make();

    /******************* setup : start *******************/
    this.env = '_noco'; //process.env['NODE_ENV'] || this.config.workingEnv || 'dev';
    this.config.workingEnv = this.env;

    this.config.type = 'docker';
    if (!this.config.toolDir) {
      this.config.toolDir = process.cwd();
    }

    this.ncToolApi = new NcToolGui(this.config);
    // if (server) {
    //   server.set('view engine', 'ejs');
    // }

    const NcMetaImpl = process.env.EE ? NcMetaImplEE : NcMetaImplCE;
    const NcMetaMgr = process.env.EE ? NcMetaMgrEE : NcMetaMgrCE;

    this.ncMeta = new NcMetaImpl(this, this.config);
    this.metaMgr = new NcMetaMgr(this, this.config, this.ncMeta);

    /******************* setup : end *******************/

    /******************* prints : start *******************/
    // this.sumTable = new Table({
    //   head: ['#DBs', '#Tables',
    //     '#GQL\nServers', '#REST\nServers',
    //     '#APIs',
    //     'Time\ntaken',
    //     // 'If avg manual effort\nper api = 15 minutes\nand\nAPI developer salary = $76k'
    //   ].map(v => colors.green(v))
    //   , colWidths: [10, 12, 9, 9, 12, 12]
    // });
    // this.table = new Table({
    //   colWidths: [4, 8, 8, 20, 9, 7, 35, 9],
    //   head: ['#', 'DB\nType', 'API\nType', 'Database', '#Tables', '#APIs', 'APIs URL', 'Time\ntaken'].map(v => colors.green(v))
    // });
    clear();
    /******************* prints : end *******************/
  }

  public async init(args?: {
    progressCallback?: Function;
    registerRoutes?: Function;
    registerGql?: Function;
    registerContext?: Function;
    afterMetaMigrationInit?: Function;
  }) {
    const {
      progressCallback
      // registerRoutes,
      // registerContext,
      // registerGql
    } = args || {};

    log('Initializing app');

    // create tool directory if missing
    mkdirp.sync(this.config.toolDir);

    this.initSentry();

    this.initWebSocket();

    // this.apiInfInfoList = [];
    //
    // this.startTime = Date.now();

    if (!this.config.try) {
      await NcConfigFactory.metaDbCreateIfNotExist(this.config);
      await this.syncMigration();
    }

    await this.ncMeta.metaInit();

    await this.readOrGenJwtSecret();

    await NcUpgrader.upgrade({ ncMeta: this.ncMeta });

    if (args?.afterMetaMigrationInit) {
      await args.afterMetaMigrationInit();
    }

    /******************* Middlewares : start *******************/
    this.router.use((req: any, _res, next) => {
      req.nc = this.requestContext;
      req.ncSiteUrl =
        this.config?.envs?.[this.env]?.publicUrl ||
        this.config?.publicUrl ||
        req.protocol + '://' + req.get('host');
      req.ncFullUrl = req.protocol + '://' + req.get('host') + req.originalUrl;
      next();
    });

    // to get ip addresses

    this.router.use(requestIp.mw());
    this.router.use(cookieParser());
    this.router.use(
      bodyParser.json({
        limit: process.env.NC_REQUEST_BODY_SIZE || 1024 * 1024
      })
    );
    this.router.use(morgan('tiny'));
    this.router.use(express.static(path.join(__dirname, './public')));

    this.router.use((req: any, _res, next) => {
      req.ncProjectId = req?.query?.project_id || req?.body?.project_id;
      next();
    });
    /*    this.router.use(this.config.dashboardPath, (req: any, _res, next) => {
          req.ncProjectId = req?.body?.project_id;
          next();
        })*/
    this.router.use(`/nc/:project_id/*`, (req: any, _res, next) => {
      req.ncProjectId = req.ncProjectId || req.params.project_id;
      next();
    });
    this.router.use(MetaAPILogger.mw);

    /******************* Middlewares : end *******************/

    await this.initProjectBuilders();

    const runTimeHandler = this.handleRuntimeChanges(progressCallback);

    this.ncToolApi.addListener(runTimeHandler);
    this.metaMgr.setListener(runTimeHandler);
    await this.metaMgr.initHandler(this.router);
    this.router.use(
      this.config.dashboardPath,
      await this.ncToolApi.expressMiddleware()
    );
    this.router.get('/', (_req, res) =>
      res.redirect(this.config.dashboardPath)
    );

    this.initSentryErrorHandler();

    /* catch error */
    this.router.use((err, _req, res, next) => {
      if (err) {
        return res.status(400).json({ msg: err.message });
      }
      next();
    });

    Tele.emit('evt_app_started', {});

    return this.router;
  }

  private initSentryErrorHandler() {
    if (process.env.NC_SENTRY_DSN) {
      this.router.use(Sentry.Handlers.errorHandler());
    }
  }

  private initSentry() {
    if (process.env.NC_SENTRY_DSN) {
      Sentry.init({ dsn: process.env.NC_SENTRY_DSN });

      // The request handler must be the first middleware on the app
      this.router.use(Sentry.Handlers.requestHandler());
    }
  }

  async initServerless() {}

  public getBuilders(): Array<RestApiBuilder | GqlApiBuilder> {
    return this.apiBuilders;
  }

  public getConfig(): NcConfig {
    return this.config;
  }

  public addToContext(context: any) {
    this.requestContext = context;
  }

  private handleRuntimeChanges(_progressCallback: Function) {
    return async (data): Promise<any> => {
      switch (data?.req?.api) {
        case 'projectCreateByWeb':
        case 'projectCreateByOneClick':
        case 'projectCreateByWebWithXCDB':
          {
            //  || data?.req?.args?.project?.title || data?.req?.args?.title
            const project = await this.ncMeta.projectGetById(data?.res?.id);
            const builder = new NcProjectBuilder(this, this.config, project);
            this.projectBuilders.push(builder);
            await builder.init(true);
          }
          break;
        // create project builder for newly imported project
        // duplicated code - projectCreateByWeb
        case 'xcMetaTablesImportZipToLocalFsAndDb':
          {
            if (data.req?.freshImport) {
              const project = await this.ncMeta.projectGetById(
                data?.req?.project_id
              );
              const builder = new NcProjectBuilder(this, this.config, project);
              this.projectBuilders.push(builder);
              await builder.init(true);
            } else {
              const projectBuilder = this.projectBuilders.find(
                pb => pb.id == data.req?.project_id
              );
              return projectBuilder?.handleRunTimeChanges(data);
            }
          }
          break;

        case 'projectUpdateByWeb':
          {
            const projectId = data.req?.project_id;
            const project = await this.ncMeta.projectGetById(
              data?.req?.project_id
            );
            const projectBuilder = this.projectBuilders.find(
              pb => pb.id === projectId
            );

            projectBuilder.updateConfig(project.config);
            await projectBuilder.reInit();
            console.log(`Project updated: ${projectId}`);
          }
          break;

        case 'projectChangeEnv':
          try {
            this.config = importFresh(
              path.join(process.cwd(), 'config.xc.json')
            ) as NcConfig;
            this.config.toolDir = this.config.toolDir || process.cwd();
            this.ncMeta.setConfig(this.config);
            this.metaMgr.setConfig(this.config);
            Object.assign(process.env, {
              NODE_ENV: this.env = this.config.workingEnv
            });
            this.router.stack.splice(0, this.router.stack.length);
            this.ncToolApi.destroy();
            this.ncToolApi.reInitialize(this.config);
            // await this.init({progressCallback});
            console.log(`Loaded env : ${data.req.args.env}`);
          } catch (e) {
            console.log(e);
          }
          break;

        default: {
          const projectBuilder = this.projectBuilders.find(
            pb => pb.id == data.req?.project_id
          );
          return projectBuilder?.handleRunTimeChanges(data);
        }
      }
    };
  }

  private async initProjectBuilders() {
    const RestAuthCtrl = process.env.EE ? RestAuthCtrlEE : RestAuthCtrlCE;

    this.projectBuilders.splice(0, this.projectBuilders.length);

    await new RestAuthCtrl(
      this as any,
      this.ncMeta?.knex,
      this.config?.meta?.db,
      this.config,
      this.ncMeta
    ).init();

    this.router.use(this.projectRouter);
    const projects = await this.ncMeta.projectList();

    for (const project of projects) {
      const projectBuilder = new NcProjectBuilder(this, this.config, project);
      this.projectBuilders.push(projectBuilder);
    }
    let i = 0;
    for (const builder of this.projectBuilders) {
      if (
        projects[i].status === 'started' ||
        projects[i].status === 'starting'
      ) {
        await builder.init();
      }
      i++;
    }
  }

  private async syncMigration(): Promise<void> {
    if (
      this.config?.toolDir
      // && !('NC_MIGRATIONS_DISABLED' in process.env)
    ) {
      const dbs = this.config?.envs?.[this.env]?.db;

      if (!dbs || !dbs.length) {
        log(
          `'${this.env}' environment doesn't have any database configuration.`
        );
        return;
      }

      for (const connectionConfig of dbs) {
        log(
          `Migrations start >> ${connectionConfig?.connection?.['database']} (${connectionConfig.meta?.dbAlias})`
        );

        try {
          /* Update database migrations */
          const migrator = new Migrator();

          /* initialize migration if folder doesn't exist */
          const migrationFolder = path.join(
            this.config.toolDir,
            'server',
            'tool',
            connectionConfig.meta.dbAlias,
            'migrations'
          );
          if (!fs.existsSync(migrationFolder)) {
            await migrator.init({
              folder: this.config?.toolDir,
              env: this.env,
              dbAlias: connectionConfig.meta.dbAlias
            });
          }

          await migrator.sync({
            folder: this.config?.toolDir,
            env: this.env,
            dbAlias: connectionConfig.meta.dbAlias
          });

          await migrator.migrationsUp({
            folder: this.config?.toolDir,
            env: this.env,
            dbAlias: connectionConfig.meta.dbAlias,
            migrationSteps: 99999,
            sqlContentMigrate: 1
          });

          log(
            `Migrations end << ${connectionConfig?.connection?.['database']} (${connectionConfig.meta?.dbAlias})`
          );
        } catch (e) {
          log(
            `Migrations Failed !! ${connectionConfig?.connection?.['database']} (${connectionConfig.meta?.dbAlias})`
          );
          console.log(e);
          // throw e;
        }
      }
    } else {
      log(
        'Warning : ignoring migrations on boot since tools directory not defined'
      );
    }
  }

  private initWebSocket(): void {
    // todo: Auth

    this.router.get(`${this.config.dashboardPath}/demo`, (_req, res) => {
      (this.ncMeta as any).updateKnex({
        client: 'sqlite3',
        connection: {
          filename: 'xcDemo.db'
        }
      });

      res.json({ msg: 'done' });
    });

    this.io = require('socket.io')();
    this.io.listen(8083);
    this.io.on('connection', client => {
      this.socketClient = client;

      client.on('disconnect', () => {
        console.log('Disconnected');
        this.socketClient = null;
      });
    });

    const statusMonitor = require('express-status-monitor')({
      websocket: this.io,
      port: 8083
    });

    this.router.use(statusMonitor);
    this.router.get(
      `${this.config.dashboardPath}/status`,
      statusMonitor.pageRoute
    );

    /*
        title: 'Express Status',  // Default title
          theme: 'default.css',     // Default styles
          path: '/status',
          socketPath: '/socket.io', // In case you use a custom path
          websocket: existingSocketIoInstance,
          spans: [{
          interval: 1,            // Every second
          retention: 60           // Keep 60 datapoints in memory
        }, {
          interval: 5,            // Every 5 seconds
          retention: 60
        }, {
          interval: 15,           // Every 15 seconds
          retention: 60
        }],
          chartVisibility: {
          cpu: true,
            mem: true,
            load: true,
            eventLoop: true,
            heap: true,
            responseTime: true,
            rps: true,
            statusCodes: true
        },
        healthChecks: [],
          ignoreStartsWith: '/admin'*/
  }

  private async readOrGenJwtSecret(): Promise<any> {
    if (this.config?.auth?.jwt && !this.config.auth.jwt.secret) {
      let secret = (
        await this.ncMeta.metaGet('', '', 'nc_store', {
          key: 'nc_auth_jwt_secret'
        })
      )?.value;
      if (!secret) {
        await this.ncMeta.metaInsert('', '', 'nc_store', {
          key: 'nc_auth_jwt_secret',
          value: secret = uuidv4()
        });
      }
      this.config.auth.jwt.secret = secret;
    }
  }
}

/**
 * @copyright Copyright (c) 2021, Xgene Cloud Ltd
 *
 * @author Naveen MR <oof1lab@gmail.com>
 * @author Pranav C Balan <pranavxc@gmail.com>
 *
 * @license GNU AGPL version 3 or any later version
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 *
 */
