// @ts-nocheck
/**
 * Argo Workflows API
 * Argo Workflows is an open source container-native workflow engine for orchestrating parallel jobs on Kubernetes. For more information, please see https://argoproj.github.io/argo-workflows/
 *
 * The version of the OpenAPI document: VERSION
 * 
 *
 * NOTE: This class is auto generated by OpenAPI Generator (https://openapi-generator.tech).
 * https://openapi-generator.tech
 * Do not edit the class manually.
 */

import { RequestFile } from './models';
import { IoArgoprojWorkflowV1alpha1Artifact } from './ioArgoprojWorkflowV1alpha1Artifact';
import { IoArgoprojWorkflowV1alpha1Parameter } from './ioArgoprojWorkflowV1alpha1Parameter';

/**
* Arguments to a template
*/
export class IoArgoprojWorkflowV1alpha1Arguments {
    /**
    * Artifacts is the list of artifacts to pass to the template or workflow
    */
    'artifacts'?: Array<IoArgoprojWorkflowV1alpha1Artifact>;
    /**
    * Parameters is the list of parameters to pass to the template or workflow
    */
    'parameters'?: Array<IoArgoprojWorkflowV1alpha1Parameter>;

    static discriminator: string | undefined = undefined;

    static attributeTypeMap: Array<{name: string, baseName: string, type: string}> = [
        {
            "name": "artifacts",
            "baseName": "artifacts",
            "type": "Array<IoArgoprojWorkflowV1alpha1Artifact>"
        },
        {
            "name": "parameters",
            "baseName": "parameters",
            "type": "Array<IoArgoprojWorkflowV1alpha1Parameter>"
        }    ];

    static getAttributeTypeMap() {
        return IoArgoprojWorkflowV1alpha1Arguments.attributeTypeMap;
    }
}
