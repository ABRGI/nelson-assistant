#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import * as config from 'config';
import { NelsonAssistantHostedZoneStack } from '../lib/nelson-assistant-hosted-zone-stack';
import { NelsonAssistantVpcStack } from '../lib/nelson-assistant-vpc-stack';
import { NelsonAssistantPeeringStack } from '../lib/nelson-assistant-peering-stack';
import { NelsonAssistantServiceStack } from '../lib/nelson-assistant-service-stack';

const app = new cdk.App();

// Account from CDK_DEPLOY_ACCOUNT env or resolved by CDK from the active AWS profile.
// Region from config so it is explicit and version-controlled.
const env = {
    account: process.env.CDK_DEPLOY_ACCOUNT || process.env.CDK_DEFAULT_ACCOUNT,
    region: config.get<string>('awsregion'),
};

const hostedZoneStack = new NelsonAssistantHostedZoneStack(app, `${config.get('environmentname')}NelsonAssistantHostedZone`, { env });

const vpcStack = new NelsonAssistantVpcStack(app, `${config.get('environmentname')}NelsonAssistantVpc`, { env });

new NelsonAssistantPeeringStack(app, `${config.get('environmentname')}NelsonAssistantPeering`, {
    env,
    hubVpc: vpcStack.vpc,
});

new NelsonAssistantServiceStack(app, `${config.get('environmentname')}NelsonAssistantService`, {
    env,
    vpc: vpcStack.vpc,
    certificate: hostedZoneStack.certificate,
    hostedZone: hostedZoneStack.hostedZone,
});
