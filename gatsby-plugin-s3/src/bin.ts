#!/usr/bin/env node

import '@babel/polyfill';
import 'fs-posix';
import AWS_S3, {
    _Object as S3Object,
    CreateBucketRequest,
    DeletePublicAccessBlockRequest,
    ListObjectsV2CommandOutput,
    NoSuchBucket,
    PutBucketWebsiteRequest,
    PutObjectRequest,
    S3
} from "@aws-sdk/client-s3";
import yargs from 'yargs';
import { CACHE_FILES, DEFAULT_OPTIONS, GatsbyRedirect, Params, S3PluginOptions } from './constants';
import { readJson } from 'fs-extra';
import klaw from 'klaw';
import PrettyError from 'pretty-error';
import streamToPromise from 'stream-to-promise';
import ora from 'ora';
import chalk from 'chalk';
import { Readable } from 'stream';
import { join, relative, resolve, sep } from 'path';
import { resolve as resolveUrl } from 'url';
import fs from 'fs';
import util from 'util';
import { minimatch } from 'minimatch';
import mime from 'mime';
import inquirer from 'inquirer';
import { createHash } from 'crypto';
import isCI from 'is-ci';
import { getS3WebsiteDomainUrl, withoutLeadingSlash } from './utilities';
import { AsyncFunction, asyncify, parallelLimit } from 'async';
import { ProxyAgent } from 'proxy-agent';
import { Provider } from '@smithy/types';
import { NodeHttpHandler } from '@aws-sdk/node-http-handler';
import { ConfiguredRetryStrategy, StandardRetryStrategy } from '@aws-sdk/util-retry';
import { Upload } from "@aws-sdk/lib-storage";

const pe = new PrettyError();

const OBJECTS_TO_REMOVE_PER_REQUEST = 1000;

const promisifiedParallelLimit: <T, E = Error>(
    tasks: Array<AsyncFunction<T, E>>,
    limit: number
) =>
    // Have to cast this due to https://github.com/DefinitelyTyped/DefinitelyTyped/issues/20497
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Promise<T[]> = util.promisify(parallelLimit) as any;

const guessRegion = async (region: string | Provider<string> | undefined): Promise<string | undefined> => {
    if (!region) {
        return undefined
    }
    if (typeof region === 'string') {
        return region;
    }
    return region();
}

const isNoSuchBucket = (error: Error): error is NoSuchBucket => "name" in error && error.name === 'NoSuchBucket'

const getBucketInfo = async (config: S3PluginOptions, s3: S3): Promise<{ exists: boolean; region?: string }> => {
    try {
        const responseData = await s3.getBucketLocation({ Bucket: config.bucketName });
        const detectedRegion = await guessRegion(
            responseData?.LocationConstraint || config.region || s3.config.region
        );
        return {
            exists: true,
            region: detectedRegion,
        };
    } catch (ex) {
        if (isNoSuchBucket(ex)) {
            return {
                exists: false,
                region: await guessRegion(config.region || s3.config.region),
            };
        }
        throw ex;
    }
};

const getParams = (path: string, params: Params): Partial<PutObjectRequest> => {
    let returned = {};
    for (const key of Object.keys(params)) {
        if (minimatch(path, key)) {
            returned = {
                ...returned,
                ...params[key],
            };
        }
    }

    return returned;
};

const listAllObjects = async (s3: S3, bucketName: string, bucketPrefix: string | undefined): Promise<Array<S3Object>> => {
    const list: Array<S3Object> = [];

    let token = null;
    do {
        const response: ListObjectsV2CommandOutput = await s3
            .listObjectsV2({
                Bucket: bucketName,
                Prefix: bucketPrefix,
                ...(token ? { ContinuationToken: token } : {}),
            });

        if (response.Contents) {
            list.push(...response.Contents);
        }

        token = response.NextContinuationToken;
    } while (token);

    return list;
};

const createSafeS3Key = (key: string): string => {
    if (sep === '\\') {
        return key.replace(/\\/g, '/');
    }

    return key;
};

export interface DeployArguments {
    yes?: boolean;
    bucket?: string;
    userAgent?: string;
}

export const makeAgent = (proxy?: string): ProxyAgent | undefined => proxy
    ? new ProxyAgent({ getProxyForUrl: () => proxy })
    : undefined

export const deploy = async ({ yes, bucket, userAgent }: DeployArguments = {}): Promise<void> => {
    const spinner = ora({ text: 'Retrieving bucket info...', color: 'magenta', stream: process.stdout }).start();
    let dontPrompt = yes;

    const uploadQueue: Array<AsyncFunction<void>> = [];

    try {
        const config: S3PluginOptions = await readJson(CACHE_FILES.config);
        const params: Params = await readJson(CACHE_FILES.params);
        const routingRules: Array<AWS_S3.RoutingRule> = await readJson(CACHE_FILES.routingRules);
        const redirectObjects: GatsbyRedirect[] = fs.existsSync(CACHE_FILES.redirectObjects)
            ? await readJson(CACHE_FILES.redirectObjects)
            : [];

        // Override the bucket name if it is set via command line
        if (bucket) {
            config.bucketName = bucket;
        }

        const maxRetries = config.maxRetries || DEFAULT_OPTIONS.maxRetries as number
        const s3 = new S3({
            region: config.region,
            endpoint: config.customAwsEndpointHostname,
            customUserAgent: userAgent ?? '',
            requestHandler: new NodeHttpHandler({
                httpAgent: makeAgent(process.env.HTTP_PROXY),
                httpsAgent: makeAgent(process.env.HTTPS_PROXY),
                requestTimeout: config.timeout,
                connectionTimeout: config.connectTimeout,
            }),
            logger: config.verbose ? console : undefined,
            retryStrategy: config.fixedRetryDelay
                ? new ConfiguredRetryStrategy(maxRetries, config.fixedRetryDelay)
                : new StandardRetryStrategy(maxRetries),
        });

        const { exists, region } = await getBucketInfo(config, s3);

        if (isCI && !dontPrompt) {
            dontPrompt = true;
        }

        if (!dontPrompt) {
            spinner.stop();
            console.log(chalk`
    {underline Please review the following:} ({dim pass -y next time to skip this})

    Deploying to bucket: {cyan.bold ${ config.bucketName }}
    In region: {yellow.bold ${ region ?? 'UNKNOWN!' }}
    Gatsby will: ${
                !exists
                    ? chalk`{bold.greenBright CREATE}`
                    : chalk`{bold.blueBright UPDATE} {dim (any existing website configuration will be overwritten!)}`
            }
`);
            const { confirm } = await inquirer.prompt([
                {
                    message: 'OK?',
                    name: 'confirm',
                    type: 'confirm',
                },
            ]);

            if (!confirm) {
                console.error('User aborted!');
                process.exit(1);
                return;
            }
            spinner.start();
        }

        spinner.text = 'Configuring bucket...';
        spinner.color = 'yellow';

        if (!exists) {
            const createParams: CreateBucketRequest = {
                Bucket: config.bucketName,
                ObjectOwnership: "BucketOwnerPreferred",
            };

            // If non-default region, specify it here (us-east-1 is default)
            if (config.region && config.region !== 'us-east-1') {
                createParams.CreateBucketConfiguration = {
                    LocationConstraint: config.region,
                };
            }
            await s3.createBucket(createParams);

            // Setup static hosting
            if (config.enableS3StaticWebsiteHosting) {
                const publicBlockConfig: DeletePublicAccessBlockRequest = {
                    Bucket: config.bucketName,
                };
                await s3.deletePublicAccessBlock(publicBlockConfig);
            }

            // Set public policy
            if (config.acl === undefined || config.acl === 'public-read') {
                await s3.putBucketPolicy({
                    Bucket: config.bucketName,
                    Policy: JSON.stringify({
                        "Version": "2012-10-17",
                        "Statement": [
                            {
                                "Sid": "PublicReadGetObject",
                                "Effect": "Allow",
                                "Principal": "*",
                                "Action": [
                                    "s3:GetObject"
                                ],
                                "Resource": [
                                    `arn:aws:s3:::${ config.bucketName }/*`
                                ]
                            }
                        ]
                    })
                })
            }

        }

        if (config.enableS3StaticWebsiteHosting) {
            const websiteConfig: PutBucketWebsiteRequest = {
                Bucket: config.bucketName,
                WebsiteConfiguration: {
                    IndexDocument: {
                        Suffix: 'index.html',
                    },
                    ErrorDocument: {
                        Key: '404.html',
                    },
                    ...(routingRules.length ? { RoutingRules: routingRules } : {}),
                },
            };

            await s3.putBucketWebsite(websiteConfig);
        }

        spinner.text = 'Listing objects...';
        spinner.color = 'green';
        const objects = await listAllObjects(s3, config.bucketName, config.bucketPrefix);
        const keyToETagMap = objects.reduce((acc: { [key: string]: string }, curr) => {
            if (curr.Key && curr.ETag) {
                acc[curr.Key] = curr.ETag;
            }
            return acc;
        }, {});

        spinner.color = 'cyan';
        spinner.text = 'Syncing...';
        const publicDir = resolve('./public');
        const stream = klaw(publicDir);
        const isKeyInUse: { [objectKey: string]: boolean } = {};

        stream.on('data', ({ path, stats }) => {
            if (!stats.isFile()) {
                return;
            }
            uploadQueue.push(
                asyncify(async () => {
                    let key = createSafeS3Key(relative(publicDir, path));
                    if (config.bucketPrefix) {
                        key = `${ config.bucketPrefix }/${ key }`;
                    }
                    const readStream = fs.createReadStream(path);
                    const hashStream = readStream.pipe(createHash('md5').setEncoding('hex'));
                    const data = await streamToPromise(hashStream);

                    const tag = `"${ data }"`;
                    const objectUnchanged = keyToETagMap[key] === tag;

                    isKeyInUse[key] = true;

                    if (!objectUnchanged) {
                        try {
                            const upload = new Upload({
                                client: s3,
                                params: {
                                    Bucket: config.bucketName,
                                    Key: key,
                                    Body: fs.createReadStream(path),
                                    ACL: config.acl === null ? undefined : config.acl ?? 'public-read',
                                    ContentType: mime.getType(path) ?? 'application/octet-stream',
                                    ...getParams(key, params),
                                },
                            });

                            upload.on('httpUploadProgress', evt => {
                                spinner.text = chalk`Syncing...
{dim   Uploading {cyan ${ key }} ${ evt.loaded?.toString() }/${ evt.total?.toString() }}`;
                            });

                            await upload.done();
                            spinner.text = chalk`Syncing...\n{dim   Uploaded {cyan ${ key }}}`;
                        } catch (ex) {
                            console.error(ex);
                            process.exit(1);
                        }
                    }
                })
            );
        });

        const base = config.protocol && config.hostname ? `${ config.protocol }://${ config.hostname }` : null;
        redirectObjects.forEach(redirect =>
            uploadQueue.push(
                asyncify(async () => {
                    const { fromPath, toPath: redirectPath } = redirect;
                    const redirectLocation = base ? resolveUrl(base, redirectPath) : redirectPath;

                    let key = withoutLeadingSlash(fromPath);
                    if (key.endsWith('/')) {
                        key = join(key, 'index.html');
                    }
                    key = createSafeS3Key(key);
                    if (config.bucketPrefix) {
                        key = withoutLeadingSlash(`${ config.bucketPrefix }/${ key }`);
                    }

                    const tag = `"${ createHash('md5')
                        .update(redirectLocation)
                        .digest('hex') }"`;
                    const objectUnchanged = keyToETagMap[key] === tag;

                    isKeyInUse[key] = true;

                    if (objectUnchanged) {
                        // object with exact hash already exists, abort.
                        return;
                    }

                    try {
                        const upload = new Upload({
                            client: s3,
                            params: {
                                Bucket: config.bucketName,
                                Key: key,
                                Body: redirectLocation,
                                ACL: config.acl === null ? undefined : config.acl ?? 'public-read',
                                ContentType: 'application/octet-stream',
                                WebsiteRedirectLocation: redirectLocation,
                                ...getParams(key, params),
                            },
                        });

                        await upload.done();

                        spinner.text = chalk`Syncing...
{dim   Created Redirect {cyan ${ key }} => {cyan ${ redirectLocation }}}\n`;
                    } catch (ex) {
                        spinner.fail(chalk`Upload failure for object {cyan ${ key }}`);
                        console.error(pe.render(ex));
                        process.exit(1);
                    }
                })
            )
        );

        await streamToPromise(stream as Readable);
        await promisifiedParallelLimit(uploadQueue, config.parallelLimit as number);

        if (config.removeNonexistentObjects) {
            const objectsToRemove = objects
                .map(obj => ({ Key: obj.Key as string }))
                .filter(obj => {
                    if (!obj.Key || isKeyInUse[obj.Key]) return false;
                    for (const glob of config.retainObjectsPatterns ?? []) {
                        if (minimatch(obj.Key, glob)) {
                            return false;
                        }
                    }
                    return true;
                });

            for (let i = 0; i < objectsToRemove.length; i += OBJECTS_TO_REMOVE_PER_REQUEST) {
                const objectsToRemoveInThisRequest = objectsToRemove.slice(i, i + OBJECTS_TO_REMOVE_PER_REQUEST);

                spinner.text = `Removing objects ${ i + 1 } to ${ i + objectsToRemoveInThisRequest.length } of ${
                    objectsToRemove.length
                }`;

                await s3
                    .deleteObjects({
                        Bucket: config.bucketName,
                        Delete: {
                            Objects: objectsToRemoveInThisRequest,
                            Quiet: true,
                        },
                    });
            }
        }

        spinner.succeed('Synced.');
        if (config.enableS3StaticWebsiteHosting) {
            const s3WebsiteDomain = getS3WebsiteDomainUrl(region ?? 'us-east-1');
            console.log(chalk`
            {bold Your website is online at:}
            {blue.underline http://${ config.bucketName }.${ s3WebsiteDomain }}
            `);
        } else {
            console.log(chalk`
            {bold Your website has now been published to:}
            {blue.underline ${ config.bucketName }}
            `);
        }
    } catch (ex) {
        spinner.fail('Failed.');
        console.error(pe.render(ex));
        process.exit(1);
    }
};

yargs
    .command(
        [ 'deploy', '$0' ],
        "Deploy bucket. If it doesn't exist, it will be created. Otherwise, it will be updated.",
        args =>
            args
                .option('yes', {
                    alias: 'y',
                    describe: 'Skip confirmation prompt',
                    type: "boolean",
                    boolean: true
                })
                .option('bucket', {
                    alias: 'b',
                    describe: 'Bucket name (if you wish to override default bucket name)',
                    type: "string"
                })
                .option('userAgent', {
                    describe: 'Allow appending custom text to the User Agent string (Used in automated tests)',
                    type: "string"
                }),
        async (argv) => deploy(argv)
    )
    .wrap(yargs.terminalWidth())
    .demandCommand(1, `Pass --help to see all available commands and options.`)
    .strict()
    .showHelpOnFail(true)
    .recommendCommands()
    .parse(process.argv.slice(2));
