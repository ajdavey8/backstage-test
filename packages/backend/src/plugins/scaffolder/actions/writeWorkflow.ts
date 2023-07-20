/*
 * Copyright 2021 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'fs-extra';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import * as yaml from 'yaml';
import { resolveSafeChildPath } from '@backstage/backend-common';
import { z } from 'zod';

const id = 'workflow:write';

const examples = [
  {
    description: 'Write a catalog yaml file',
    example: yaml.stringify({
      steps: [
        {
          action: id,
          id: 'create-catalog-info-file',
          name: 'Create catalog file',
          input: {
            entity: {
              apiVersion: 'backstage.io/v1alpha1',
              kind: 'Component',
              metadata: {
                name: 'test',
                annotations: {},
              },
              spec: {
                type: 'service',
                lifecycle: 'production',
                owner: 'default/owner',
              },
            },
          },
        },
      ],
    }),
  },
];

const defaultWorkflow = {
  name: 'Auth :: Deploy :: Dev',
  on: 'workflow_dispatch',

  jobs: {
    'deploy-dev-preview': {
      uses: './.github/workflows/deploy-service.yml',
      with: {
        'github-environment': 'DevPreview',
        stage: "$(echo ${{ github.actor }} | awk '{print tolower($0)}')",
        'service-name': '@shieldpay/auth',
        'service-path': 'backend/services/auth',
        'lint-code': false,
        'test-code': false,
        'github-author': '${{ github.actor }}',
        'install-everything': true,
      },
      secrets: {
        'aws-role-arn': '${{ secrets.DEPLOYMENT_ROLE_ARN }}',
        'aws-account-id': '${{ secrets.AWS_ACCOUNT_ID }}',
      },
    },
  },
};

/**
 * Writes a catalog descriptor file containing the provided entity to a path in the workspace.
 * @public
 */

export const createWorkflowAction = () => {
  return createTemplateAction<{
    repoUrl?: string;
  }>({
    id,
    schema: {
      input: {
        type: 'object',
        properties: {
          repoUrl: {
            title: 'Repository Location',
            description: `Accepts the format 'github.com?repo=reponame&owner=owner' where 'reponame' is the repository name and 'owner' is an organization or username`,
            type: 'string',
          },
        },
      },
    },
    async handler(ctx) {
      ctx.logStream.write(`Writing catalog-info.yaml`);

      const path = '.gitub/worflows/test.yaml';

      await fs.writeFile(
        resolveSafeChildPath(ctx.workspacePath, path),
        yaml.stringify(defaultWorkflow),
      );
    },
  });
};
