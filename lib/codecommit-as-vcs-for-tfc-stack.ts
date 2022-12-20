import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as codeBuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as  ssmparameter  from 'aws-cdk-lib/aws-ssm';

export class CodecommitAsVcsForTfcStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);


    const tfcrepo = new codecommit.Repository(this, 'tfcrepo', {
      repositoryName: `${this.node.tryGetContext('repo_name')}`
    });


    const token = new ssmparameter.StringParameter(this, 'token', {
      parameterName: 'tfc_token',
      stringValue: this.node.tryGetContext('tfc_token')
    });


    const buildPolicy = new iam.PolicyDocument({
      statements: [ new iam.PolicyStatement({
        actions: [
          "ssm:GetParameters",
          "ssm:GetParameter"
      ],
      resources: [token.parameterArn]
      })

      ]
    }
    )
    const buildRole = new iam.Role(this, 'tfcCodeBuildRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      inlinePolicies: {
        BuildPolicy: buildPolicy},
   
    });

    const tfcBuildProject = new codeBuild.Project(this, 'sampleBuildProject', {
      projectName: 'tfcBuildProject',
      environment: {
        buildImage: codeBuild.LinuxBuildImage.AMAZON_LINUX_2_2,
        privileged: true,
      },
      environmentVariables: {
        TF_REPO_PATH: {
          value: this.node.tryGetContext('template_path'),
        },
        TF_ORG: {
          value: this.node.tryGetContext('tf_org'),
        },
        TF_WORKSPACE: {
          value: this.node.tryGetContext('tf_workspace'),
        },
        TOKEN: {
          value: token.parameterName,
          type: codeBuild.BuildEnvironmentVariableType.PARAMETER_STORE,
        }
      },
      
      buildSpec: codeBuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          build: {
            commands: 
           `#!/bin/bash
            CONTENT_DIRECTORY=$TF_REPO_PATH
            ORG_NAME=$TF_ORG
            WORKSPACE_NAME=$TF_WORKSPACE
            UPLOAD_FILE_NAME="./content-$(date +%s).tar.gz"
            tar -zcvf "$UPLOAD_FILE_NAME" -C "$CONTENT_DIRECTORY" .

            WORKSPACE_ID=$(curl \
              --header "Authorization: Bearer $TOKEN" \
              --header "Content-Type: application/vnd.api+json" \
              https://app.terraform.io/api/v2/organizations/$ORG_NAME/workspaces/$WORKSPACE_NAME \
              | jq -r '.data.id')

            echo '{"data":{"type":"configuration-versions"}}' > ./create_config_version.json

            UPLOAD_URL=($(curl \
              --header "Authorization: Bearer $TOKEN" \
              --header "Content-Type: application/vnd.api+json" \
              --request POST \
              --data @create_config_version.json \
              https://app.terraform.io/api/v2/workspaces/$WORKSPACE_ID/configuration-versions \
              | jq -r '.data.attributes."upload-url"'))

            curl \
              --header "Content-Type: application/octet-stream" \
              --request PUT \
              --data-binary @"$UPLOAD_FILE_NAME" \
              $UPLOAD_URL

            rm "$UPLOAD_FILE_NAME"
            rm ./create_config_version.json

            `
          },
        },
       
      }),
    });

    const sourceOutput = new codepipeline.Artifact();
    const buildAction = new codepipeline_actions.CodeBuildAction({
      actionName: 'PushtoTFC',
      project: tfcBuildProject,
      input: sourceOutput,
    });
    const sourceAction = new codepipeline_actions.CodeCommitSourceAction({
      actionName: 'FetchTFtemplates',
      repository: tfcrepo,
      branch: 'main',
      output: sourceOutput,
    });

    const pipeline = new codepipeline.Pipeline(this, 'tfcPipeline', {
      pipelineName: 'tfcPipeline',
      enableKeyRotation: true
    });

    pipeline.addStage({
      stageName: 'Source',
      actions: [sourceAction],
    });

    pipeline.addStage({
      stageName: 'Build',
      actions: [buildAction],
    });

  }
}
