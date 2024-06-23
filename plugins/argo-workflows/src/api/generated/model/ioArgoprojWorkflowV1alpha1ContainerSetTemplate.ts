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
import { IoArgoprojWorkflowV1alpha1ContainerNode } from './ioArgoprojWorkflowV1alpha1ContainerNode';
import { IoArgoprojWorkflowV1alpha1ContainerSetRetryStrategy } from './ioArgoprojWorkflowV1alpha1ContainerSetRetryStrategy';
import { IoK8sApiCoreV1VolumeMount } from './ioK8sApiCoreV1VolumeMount';

export class IoArgoprojWorkflowV1alpha1ContainerSetTemplate {
    'containers': Array<IoArgoprojWorkflowV1alpha1ContainerNode>;
    'retryStrategy'?: IoArgoprojWorkflowV1alpha1ContainerSetRetryStrategy;
    'volumeMounts'?: Array<IoK8sApiCoreV1VolumeMount>;

    static discriminator: string | undefined = undefined;

    static attributeTypeMap: Array<{name: string, baseName: string, type: string}> = [
        {
            "name": "containers",
            "baseName": "containers",
            "type": "Array<IoArgoprojWorkflowV1alpha1ContainerNode>"
        },
        {
            "name": "retryStrategy",
            "baseName": "retryStrategy",
            "type": "IoArgoprojWorkflowV1alpha1ContainerSetRetryStrategy"
        },
        {
            "name": "volumeMounts",
            "baseName": "volumeMounts",
            "type": "Array<IoK8sApiCoreV1VolumeMount>"
        }    ];

    static getAttributeTypeMap() {
        return IoArgoprojWorkflowV1alpha1ContainerSetTemplate.attributeTypeMap;
    }
}

