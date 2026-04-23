import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as config from 'config';
import { Construct } from 'constructs';

interface ClientPeeringConfig {
    tenantid: string;
    vpcid: string;
    cidr: string;
    /** Hub-side route table IDs to add the return route to. */
    routetableids: string[];
    /** Set when the peer VPC is in a different region from the hub. */
    peerregion?: string;
}

export interface NelsonAssistantPeeringStackProps extends cdk.StackProps {
    hubVpc: ec2.Vpc;
}

/**
 * Peers the hub VPC with each client Nelson VPC and the shared RDS VPC.
 * Adds hub-side routes automatically. Client-side routes must be added
 * manually (or via cross-account CDK) — see README for the one-liner.
 *
 * Add clients under nelsonassistant.clients[] in config.
 */
export class NelsonAssistantPeeringStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: NelsonAssistantPeeringStackProps) {
        super(scope, id, props);

        const clients: ClientPeeringConfig[] = config.has('nelsonassistant.clients')
            ? config.get('nelsonassistant.clients')
            : [];

        for (const client of clients) {
            this.peerWith(props.hubVpc, client.tenantid, client.vpcid, client.cidr, client.routetableids, client.peerregion);
        }
    }

    private peerWith(
        hubVpc: ec2.Vpc,
        name: string,
        peerVpcId: string,
        peerCidr: string,
        hubRouteTableIds: string[],
        peerRegion?: string,
    ) {
        const peering = new ec2.CfnVPCPeeringConnection(this, `Peering-${name}`, {
            vpcId: hubVpc.vpcId,
            peerVpcId,
            ...(peerRegion ? { peerRegion } : {}),
            tags: [{ key: 'Name', value: `${config.get('environmentname')}-assistant-to-${name}` }],
        });

        // Add a route in each hub route table pointing to the client CIDR via the peering.
        hubRouteTableIds.forEach((rtbId, i) => {
            new ec2.CfnRoute(this, `Route-${name}-${i}`, {
                routeTableId: rtbId,
                destinationCidrBlock: peerCidr,
                vpcPeeringConnectionId: peering.ref,
            });
        });

        // Export the peering connection id so operators can add the reverse
        // route on the client side. CloudFormation rejects intrinsic refs in
        // the Description field, so keep the description literal.
        new cdk.CfnOutput(this, `PeeringNote-${name}`, {
            value: peering.ref,
            description: `VPC peering connection id for ${name}. Add the reverse route (hub CIDR -> this peering) in the peer VPC route tables.`,
        });
    }
}
