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
import { IoK8sApiCoreV1PersistentVolumeClaimCondition } from './ioK8sApiCoreV1PersistentVolumeClaimCondition';

/**
* PersistentVolumeClaimStatus is the current status of a persistent volume claim.
*/
export class IoK8sApiCoreV1PersistentVolumeClaimStatus {
    /**
    * AccessModes contains the actual access modes the volume backing the PVC has. More info: https://kubernetes.io/docs/concepts/storage/persistent-volumes#access-modes-1
    */
    'accessModes'?: Array<string>;
    /**
    * The storage resource within AllocatedResources tracks the capacity allocated to a PVC. It may be larger than the actual capacity when a volume expansion operation is requested. For storage quota, the larger value from allocatedResources and PVC.spec.resources is used. If allocatedResources is not set, PVC.spec.resources alone is used for quota calculation. If a volume expansion capacity request is lowered, allocatedResources is only lowered if there are no expansion operations in progress and if the actual volume capacity is equal or lower than the requested capacity. This is an alpha field and requires enabling RecoverVolumeExpansionFailure feature.
    */
    'allocatedResources'?: { [key: string]: string; };
    /**
    * Represents the actual resources of the underlying volume.
    */
    'capacity'?: { [key: string]: string; };
    /**
    * Current Condition of persistent volume claim. If underlying persistent volume is being resized then the Condition will be set to \'ResizeStarted\'.
    */
    'conditions'?: Array<IoK8sApiCoreV1PersistentVolumeClaimCondition>;
    /**
    * Phase represents the current phase of PersistentVolumeClaim.  Possible enum values:  - `\"Bound\"` used for PersistentVolumeClaims that are bound  - `\"Lost\"` used for PersistentVolumeClaims that lost their underlying PersistentVolume. The claim was bound to a PersistentVolume and this volume does not exist any longer and all data on it was lost.  - `\"Pending\"` used for PersistentVolumeClaims that are not yet bound
    */
    'phase'?: IoK8sApiCoreV1PersistentVolumeClaimStatus.PhaseEnum;
    /**
    * ResizeStatus stores status of resize operation. ResizeStatus is not set by default but when expansion is complete resizeStatus is set to empty string by resize controller or kubelet. This is an alpha field and requires enabling RecoverVolumeExpansionFailure feature.
    */
    'resizeStatus'?: string;

    static discriminator: string | undefined = undefined;

    static attributeTypeMap: Array<{name: string, baseName: string, type: string}> = [
        {
            "name": "accessModes",
            "baseName": "accessModes",
            "type": "Array<string>"
        },
        {
            "name": "allocatedResources",
            "baseName": "allocatedResources",
            "type": "{ [key: string]: string; }"
        },
        {
            "name": "capacity",
            "baseName": "capacity",
            "type": "{ [key: string]: string; }"
        },
        {
            "name": "conditions",
            "baseName": "conditions",
            "type": "Array<IoK8sApiCoreV1PersistentVolumeClaimCondition>"
        },
        {
            "name": "phase",
            "baseName": "phase",
            "type": "IoK8sApiCoreV1PersistentVolumeClaimStatus.PhaseEnum"
        },
        {
            "name": "resizeStatus",
            "baseName": "resizeStatus",
            "type": "string"
        }    ];

    static getAttributeTypeMap() {
        return IoK8sApiCoreV1PersistentVolumeClaimStatus.attributeTypeMap;
    }
}

export namespace IoK8sApiCoreV1PersistentVolumeClaimStatus {
    export enum PhaseEnum {
        Bound = <any> 'Bound',
        Lost = <any> 'Lost',
        Pending = <any> 'Pending'
    }
}
