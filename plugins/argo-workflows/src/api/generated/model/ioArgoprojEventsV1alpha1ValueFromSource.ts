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
import { IoK8sApiCoreV1ConfigMapKeySelector } from './ioK8sApiCoreV1ConfigMapKeySelector';
import { IoK8sApiCoreV1SecretKeySelector } from './ioK8sApiCoreV1SecretKeySelector';

export class IoArgoprojEventsV1alpha1ValueFromSource {
    'configMapKeyRef'?: IoK8sApiCoreV1ConfigMapKeySelector;
    'secretKeyRef'?: IoK8sApiCoreV1SecretKeySelector;

    static discriminator: string | undefined = undefined;

    static attributeTypeMap: Array<{name: string, baseName: string, type: string}> = [
        {
            "name": "configMapKeyRef",
            "baseName": "configMapKeyRef",
            "type": "IoK8sApiCoreV1ConfigMapKeySelector"
        },
        {
            "name": "secretKeyRef",
            "baseName": "secretKeyRef",
            "type": "IoK8sApiCoreV1SecretKeySelector"
        }    ];

    static getAttributeTypeMap() {
        return IoArgoprojEventsV1alpha1ValueFromSource.attributeTypeMap;
    }
}

