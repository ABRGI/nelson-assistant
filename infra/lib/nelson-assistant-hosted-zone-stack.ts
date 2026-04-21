import * as cdk from 'aws-cdk-lib';
import * as config from 'config';
import { HostedZone, IHostedZone } from 'aws-cdk-lib/aws-route53';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';

export class NelsonAssistantHostedZoneStack extends cdk.Stack {
    readonly hostedZone: IHostedZone;
    readonly certificate: Certificate;

    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        this.hostedZone = HostedZone.fromLookup(this, 'HostedZone', {
            domainName: config.get<string>('nelsonassistant.hostedzone'),
        });

        this.certificate = new Certificate(this, 'Certificate', {
            domainName: config.get<string>('nelsonassistant.domain'),
            validation: CertificateValidation.fromDns(this.hostedZone),
            certificateName: 'NelsonAssistantCertificate',
        });
        this.certificate.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        cdk.Aspects.of(this.certificate).add(new cdk.Tag('nelson:role', 'nelson-assistant'));
        cdk.Aspects.of(this.certificate).add(new cdk.Tag('nelson:environment', config.get('environmentname')));
    }
}
