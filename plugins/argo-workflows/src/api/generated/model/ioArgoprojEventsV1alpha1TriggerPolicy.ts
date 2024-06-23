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
import { IoArgoprojEventsV1alpha1K8SResourcePolicy } from './ioArgoprojEventsV1alpha1K8SResourcePolicy';
import { IoArgoprojEventsV1alpha1StatusPolicy } from './ioArgoprojEventsV1alpha1StatusPolicy';

export class IoArgoprojEventsV1alpha1TriggerPolicy {
    'k8s'?: IoArgoprojEventsV1alpha1K8SResourcePolicy;
    'status'?: IoArgoprojEventsV1alpha1StatusPolicy;

    static discriminator: string | undefined = undefined;

    static attributeTypeMap: Array<{name: string, baseName: string, type: string}> = [
        {
            "name": "k8s",
            "baseName": "k8s",
            "type": "IoArgoprojEventsV1alpha1K8SResourcePolicy"
        },
        {
            "name": "status",
            "baseName": "status",
            "type": "IoArgoprojEventsV1alpha1StatusPolicy"
        }    ];

    static getAttributeTypeMap() {
        return IoArgoprojEventsV1alpha1TriggerPolicy.attributeTypeMap;
    }
}

