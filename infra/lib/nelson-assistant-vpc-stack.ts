import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as config from 'config';
import { Construct } from 'constructs';

/**
 * Dedicated "hub" VPC for the Nelson Assistant.
 * Public subnets only (no NAT) — ECS tasks use assignPublicIp.
 * AWS-internal traffic (Bedrock, SM, ECR, CW Logs, STS, S3) goes through VPC endpoints.
 */
export class NelsonAssistantVpcStack extends cdk.Stack {
    readonly vpc: ec2.Vpc;

    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        this.vpc = new ec2.Vpc(this, 'Vpc', {
            ipAddresses: ec2.IpAddresses.cidr(config.get('nelsonassistant.hubcidr')),
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [
                {
                    name: 'public',
                    subnetType: ec2.SubnetType.PUBLIC,
                    cidrMask: 24,
                },
            ],
            vpcName: `${config.get('environmentname')}-nelson-assistant`,
        });

        // VPC interface endpoints so tasks never need a NAT for AWS APIs
        const endpointSg = new ec2.SecurityGroup(this, 'EndpointSg', {
            vpc: this.vpc,
            description: 'Allow HTTPS from within the VPC to interface endpoints',
        });
        endpointSg.addIngressRule(ec2.Peer.ipv4(this.vpc.vpcCidrBlock), ec2.Port.tcp(443));

        const interfaceEndpoints: ec2.InterfaceVpcEndpointAwsService[] = [
            ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
            ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
            ec2.InterfaceVpcEndpointAwsService.ECR,
            ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
            ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
            ec2.InterfaceVpcEndpointAwsService.STS,
        ];
        for (const svc of interfaceEndpoints) {
            this.vpc.addInterfaceEndpoint(svc.shortName.replace(/[^a-zA-Z0-9]/g, ''), {
                service: svc,
                securityGroups: [endpointSg],
                privateDnsEnabled: true,
            });
        }

        this.vpc.addGatewayEndpoint('S3', {
            service: ec2.GatewayVpcEndpointAwsService.S3,
        });

        tag(this.vpc, 'nelson-assistant', 'hub');
        for (const subnet of this.vpc.publicSubnets) {
            cdk.Aspects.of(subnet).add(new cdk.Tag('Name',
                `${config.get('environmentname')}-assistant-public-${subnet.availabilityZone}`));
        }
    }
}

function tag(scope: Construct, client: string, role: string) {
    cdk.Aspects.of(scope).add(new cdk.Tag('nelson:client', client));
    cdk.Aspects.of(scope).add(new cdk.Tag('nelson:role', role));
    cdk.Aspects.of(scope).add(new cdk.Tag('nelson:environment', config.get('environmentname')));
}
