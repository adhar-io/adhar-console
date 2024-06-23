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

/**
* ArtifactResult describes the result of attempting to delete a given Artifact
*/
export class IoArgoprojWorkflowV1alpha1ArtifactResult {
    /**
    * Error is an optional error message which should be set if Success==false
    */
    'error'?: string;
    /**
    * Name is the name of the Artifact
    */
    'name': string;
    /**
    * Success describes whether the deletion succeeded
    */
    'success'?: boolean;

    static discriminator: string | undefined = undefined;

    static attributeTypeMap: Array<{name: string, baseName: string, type: string}> = [
        {
            "name": "error",
            "baseName": "error",
            "type": "string"
        },
        {
            "name": "name",
            "baseName": "name",
            "type": "string"
        },
        {
            "name": "success",
            "baseName": "success",
            "type": "boolean"
        }    ];

    static getAttributeTypeMap() {
        return IoArgoprojWorkflowV1alpha1ArtifactResult.attributeTypeMap;
    }
}

