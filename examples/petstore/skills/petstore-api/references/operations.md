# Swagger Petstore - OpenAPI 3.0: operations

19 operations. Mode: read-only.

## Tool `pet`

### findPetsByStatus

`GET /pet/findByStatus`

Finds Pets by status.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `status` | query | "available"\|"pending"\|"sold" | yes | Status values that need to be considered for filter |

Signature: `findPetsByStatus(status: "available"|"pending"|"sold")`

### findPetsByTags

`GET /pet/findByTags`

Finds Pets by tags.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `tags` | query | string[] | yes | Tags to filter by |

Signature: `findPetsByTags(tags: string[])`

### getPetById

`GET /pet/{petId}`

Find pet by ID.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `petId` | path | integer | yes | ID of pet to return |

Signature: `getPetById(petId: integer)`

## Tool `store`

### getInventory

`GET /store/inventory`

Returns pet inventories by status.

No parameters.

Signature: `getInventory()`

### getOrderById

`GET /store/order/{orderId}`

Find purchase order by ID.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `orderId` | path | integer | yes | ID of order that needs to be fetched |

Signature: `getOrderById(orderId: integer)`

## Tool `user`

### loginUser

`GET /user/login`

Logs user into the system.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `username` | query | string | no | The user name for login |
| `password` | query | string | no | The password for login in clear text |

Signature: `loginUser(username?: string, password?: string)`

### logoutUser

`GET /user/logout`

Logs out current logged in user session.

No parameters.

Signature: `logoutUser()`

### getUserByName

`GET /user/{username}`

Get user by user name.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `username` | path | string | yes | The name that needs to be fetched. Use user1 for testing |

Signature: `getUserByName(username: string)`

## Blocked in the current mode

### addPet

`POST /pet` (write)

Add a new pet to the store.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `body` | body | {id?: integer, name: string, category?: object, photoUrls: string[], tags?: object[], status?: "available"\|"pending"\|"sold"} | yes | application/json |

Signature: `addPet(body: {id?: integer, name: string, category?: object, photoUrls: string[], tags?: object[], status?: "available"|"pending"|"sold"})`

### updatePet

`PUT /pet` (write)

Update an existing pet.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `body` | body | {id?: integer, name: string, category?: object, photoUrls: string[], tags?: object[], status?: "available"\|"pending"\|"sold"} | yes | application/json |

Signature: `updatePet(body: {id?: integer, name: string, category?: object, photoUrls: string[], tags?: object[], status?: "available"|"pending"|"sold"})`

### updatePetWithForm

`POST /pet/{petId}` (write)

Updates a pet in the store with form data.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `petId` | path | integer | yes | ID of pet that needs to be updated |
| `name` | query | string | no | Name of pet that needs to be updated |
| `status` | query | string | no | Status of pet that needs to be updated |

Signature: `updatePetWithForm(petId: integer, name?: string, status?: string)`

### deletePet

`DELETE /pet/{petId}` (destructive)

Deletes a pet.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `api_key` | header | string | no |  |
| `petId` | path | integer | yes | Pet id to delete |

Signature: `deletePet(api_key?: string, petId: integer)`

### uploadFile

`POST /pet/{petId}/uploadImage` (write)

Uploads an image.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `petId` | path | integer | yes | ID of pet to update |
| `additionalMetadata` | query | string | no | Additional Metadata |
| `body` | body | string(binary) | no | application/octet-stream |

Signature: `uploadFile(petId: integer, additionalMetadata?: string, body?: string(binary))`

### placeOrder

`POST /store/order` (write)

Place an order for a pet.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `body` | body | {id?: integer, petId?: integer, quantity?: integer, shipDate?: string(date-time), status?: "placed"\|"approved"\|"delivered", complete?: boolean} | no | application/json |

Signature: `placeOrder(body?: {id?: integer, petId?: integer, quantity?: integer, shipDate?: string(date-time), status?: "placed"|"approved"|"delivered", complete?: boolean})`

### deleteOrder

`DELETE /store/order/{orderId}` (destructive)

Delete purchase order by identifier.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `orderId` | path | integer | yes | ID of the order that needs to be deleted |

Signature: `deleteOrder(orderId: integer)`

### createUser

`POST /user` (write)

Create user.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `body` | body | {id?: integer, username?: string, firstName?: string, lastName?: string, email?: string, password?: string, …} | no | application/json |

Signature: `createUser(body?: {id?: integer, username?: string, firstName?: string, lastName?: string, email?: string, password?: string, …})`

### createUsersWithListInput

`POST /user/createWithList` (write)

Creates list of users with given input array.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `body` | body | object[] | no | application/json |

Signature: `createUsersWithListInput(body?: object[])`

### updateUser

`PUT /user/{username}` (write)

Update user resource.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `username` | path | string | yes | name that need to be updated |
| `body` | body | {id?: integer, username?: string, firstName?: string, lastName?: string, email?: string, password?: string, …} | no | application/json |

Signature: `updateUser(username: string, body?: {id?: integer, username?: string, firstName?: string, lastName?: string, email?: string, password?: string, …})`

### deleteUser

`DELETE /user/{username}` (destructive)

Delete user resource.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `username` | path | string | yes | The name that needs to be deleted |

Signature: `deleteUser(username: string)`
