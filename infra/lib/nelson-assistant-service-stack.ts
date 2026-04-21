import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as config from 'config';
import { Construct } from 'constructs';

export interface NelsonAssistantServiceStackProps extends cdk.StackProps {
    vpc: ec2.Vpc;
    certificate: cdk.aws_certificatemanager.Certificate;
    hostedZone: route53.IHostedZone;
}

/**
 * ECS Fargate service for the Nelson Assistant.
 * Tasks use assignPublicIp (no NAT) and reach AWS APIs through VPC endpoints.
 * EFS shares the git worktree pool across tasks — avoids redundant bare repo
 * clones when desiredCount > 1. S3 holds conversation state and client registry.
 */
export class NelsonAssistantServiceStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: NelsonAssistantServiceStackProps) {
        super(scope, id, props);

        const env = config.get<string>('environmentname');

        // ── KMS key (state bucket + EFS + secrets) ────────────────────────────
        const key = new kms.Key(this, 'Key', {
            description: `${env} nelson-assistant state key`,
            enableKeyRotation: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            alias: `${env}-nelson-assistant`,
        });

        // ── State bucket ──────────────────────────────────────────────────────
        const stateBucket = new s3.Bucket(this, 'StateBucket', {
            bucketName: `${env.toLowerCase()}-nelson-assistant-state`,
            encryptionKey: key,
            bucketKeyEnabled: true,
            versioned: true,
            autoDeleteObjects: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            lifecycleRules: [
                {
                    prefix: 'threads/',
                    transitions: [{ storageClass: s3.StorageClass.GLACIER, transitionAfter: cdk.Duration.days(90) }],
                    expiration: cdk.Duration.days(365),
                },
            ],
        });

        // ── ECR repository ────────────────────────────────────────────────────
        const repo = new ecr.Repository(this, 'Repo', {
            repositoryName: `${env.toLowerCase()}-nelson-assistant`,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            emptyOnDelete: true,
        });

        // ── EFS for git worktrees (shared across tasks) ───────────────────────
        const efsSg = new ec2.SecurityGroup(this, 'EfsSg', {
            vpc: props.vpc,
            description: 'EFS - allow NFS from ECS tasks',
        });
        const fileSystem = new efs.FileSystem(this, 'Efs', {
            vpc: props.vpc,
            securityGroup: efsSg,
            encrypted: true,
            kmsKey: key,
            performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        const accessPoint = new efs.AccessPoint(this, 'WorktreeAP', {
            fileSystem,
            path: '/work',
            createAcl: { ownerUid: '1000', ownerGid: '1000', permissions: '750' },
            posixUser: { uid: '1000', gid: '1000' },
        });

        // ── Task role ─────────────────────────────────────────────────────────
        const taskRole = new iam.Role(this, 'TaskRole', {
            roleName: `${env}-nelson-assistant-task`,
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        });
        stateBucket.grantReadWrite(taskRole);
        key.grantEncryptDecrypt(taskRole);
        fileSystem.grantRootAccess(taskRole);
        taskRole.addToPolicy(new iam.PolicyStatement({
            actions: ['secretsmanager:GetSecretValue'],
            resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:nelson-assistant/*`],
        }));
        taskRole.addToPolicy(new iam.PolicyStatement({
            actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
            resources: ['*'],
        }));
        taskRole.addToPolicy(new iam.PolicyStatement({
            actions: ['ecr:DescribeImages'],
            resources: ['*'],
        }));
        taskRole.addToPolicy(new iam.PolicyStatement({
            actions: ['dynamodb:Scan', 'dynamodb:GetItem'],
            resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/nelson-tenants`],
        }));
        // DescribeLogGroups cannot be scoped to a resource ARN by AWS; the other
        // log actions below are scoped to /ecs/* and /aws/codebuild/*.
        taskRole.addToPolicy(new iam.PolicyStatement({
            actions: ['logs:DescribeLogGroups'],
            resources: ['*'],
        }));
        taskRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'logs:DescribeLogStreams',
                'logs:GetLogEvents',
                'logs:FilterLogEvents',
                'logs:StartQuery',
                'logs:StopQuery',
                'logs:GetQueryResults',
            ],
            resources: [
                `arn:aws:logs:${this.region}:${this.account}:log-group:/ecs/*`,
                `arn:aws:logs:${this.region}:${this.account}:log-group:/ecs/*:*`,
                `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/codebuild/*`,
                `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/codebuild/*:*`,
            ],
        }));

        // ── ECS cluster + task definition ─────────────────────────────────────
        const logGroup = new logs.LogGroup(this, 'LogGroup', {
            logGroupName: `/ecs/${env}-nelson-assistant`,
            retention: logs.RetentionDays.THREE_MONTHS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const cluster = new ecs.Cluster(this, 'Cluster', {
            clusterName: `${env}-nelson-assistant`,
            vpc: props.vpc,
        });

        const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
            family: `${env}-nelson-assistant`,
            cpu: Number(config.get('nelsonassistant.cpu')),
            memoryLimitMiB: Number(config.get('nelsonassistant.memory')),
            taskRole,
            volumes: [{
                name: 'work',
                efsVolumeConfiguration: {
                    fileSystemId: fileSystem.fileSystemId,
                    authorizationConfig: { accessPointId: accessPoint.accessPointId, iam: 'ENABLED' },
                    transitEncryption: 'ENABLED',
                },
            }],
        });

        const container = taskDef.addContainer('App', {
            image: ecs.ContainerImage.fromEcrRepository(repo, 'latest'),
            logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'app', logGroup }),
            portMappings: [{ containerPort: 3000 }],
            healthCheck: {
                command: ['CMD-SHELL', 'curl -fsS http://localhost:3000/health || exit 1'],
                interval: cdk.Duration.seconds(30),
                timeout: cdk.Duration.seconds(5),
                startPeriod: cdk.Duration.seconds(20),
                retries: 3,
            },
            environment: {
                NODE_ENV: 'production',
                STORAGE_MODE: 'aws',
                STATE_BUCKET: stateBucket.bucketName,
                AWS_REGION: this.region,
                WORKSPACE_ROOT: '/work',
                ESCALATION_SLACK_USER_ID: config.get<string>('nelsonassistant.escalationslackuserid'),
                NELSON_USER_MGMT_BASE_URL: config.get<string>('nelsonassistant.nelsonusermgmtbaseurl'),
                DEFAULT_TENANT_ID: config.get<string>('nelsonassistant.defaulttenantid'),
                BEDROCK_SONNET_MODEL_ID: config.get<string>('nelsonassistant.sonnetmodelid'),
                BEDROCK_HAIKU_MODEL_ID: config.get<string>('nelsonassistant.haikumodelid'),
                AUTH_CALLBACK_BASE_URL: `https://${config.get<string>('nelsonassistant.domain')}`,
            },
            // No ECS-level secret injection — the container fetches the full
            // nelson-assistant/runtime secret at startup via fetchRuntimeSecret().
        });
        container.addMountPoints({ containerPath: '/work', sourceVolume: 'work', readOnly: false });

        // ── Security groups ───────────────────────────────────────────────────
        const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
            vpc: props.vpc,
            description: 'Nelson Assistant ALB - public HTTPS',
        });
        albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443));

        const taskSg = new ec2.SecurityGroup(this, 'TaskSg', {
            vpc: props.vpc,
            description: 'Nelson Assistant ECS tasks',
        });
        taskSg.addIngressRule(albSg, ec2.Port.tcp(3000));
        efsSg.addIngressRule(taskSg, ec2.Port.tcp(2049));

        // ── ALB ───────────────────────────────────────────────────────────────
        const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
            vpc: props.vpc,
            internetFacing: true,
            loadBalancerName: `${env}-nelson-assistant`,
            securityGroup: albSg,
            vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        });

        const tg = new elbv2.ApplicationTargetGroup(this, 'Tg', {
            port: 3000,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP,
            vpc: props.vpc,
            targetGroupName: `${env}-assistant-tg`,
            healthCheck: { path: '/health', interval: cdk.Duration.seconds(60) },
        });

        alb.addListener('Https', {
            port: 443,
            protocol: elbv2.ApplicationProtocol.HTTPS,
            certificates: [props.certificate],
            defaultTargetGroups: [tg],
        });

        // ── ECS service ───────────────────────────────────────────────────────
        const service = new ecs.FargateService(this, 'Service', {
            cluster,
            taskDefinition: taskDef,
            serviceName: `${env}-nelson-assistant`,
            desiredCount: Number(config.get('nelsonassistant.desiredcount')),
            securityGroups: [taskSg],
            assignPublicIp: true,
            vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
            minHealthyPercent: 100,
            maxHealthyPercent: 200,
        });
        service.attachToApplicationTargetGroup(tg);

        // ── Route53 A record ──────────────────────────────────────────────────
        new route53.ARecord(this, 'AliasRecord', {
            zone: props.hostedZone,
            recordName: config.get<string>('nelsonassistant.domain'),
            target: route53.RecordTarget.fromAlias(new route53targets.LoadBalancerTarget(alb)),
        });

        // ── Outputs ───────────────────────────────────────────────────────────
        new cdk.CfnOutput(this, 'AlbDns', { value: alb.loadBalancerDnsName });
        new cdk.CfnOutput(this, 'EcrRepo', { value: repo.repositoryUri });
        new cdk.CfnOutput(this, 'StateBucketName', { value: stateBucket.bucketName });
    }
}
