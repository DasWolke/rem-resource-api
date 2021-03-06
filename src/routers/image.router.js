/**
 * Created by Julian on 02.05.2017.
 */
const Url = require('url');
let multer = require('multer');
let storage = multer.memoryStorage();
let upload = multer({ storage: storage });
const winston = require('winston');
const ImageModel = require('../DB/image.mongo');
const CampaignModel = require('../DB/campaign.mongo');
const axios = require('axios');
const BaseRouter = require('@weeb_services/wapi-core').BaseRouter;
const HTTPCodes = require('@weeb_services/wapi-core').Constants.HTTPCodes;
const pkg = require('../../package.json');
const RedirectController = require('../controller/redirect.controller');
const redirectController = new RedirectController();

class ImageRouter extends BaseRouter {
    constructor() {
        super();
        this.router()
            .post('/upload', upload.single('file'), async (req, res) => {
                let campaign;
                try {
                    if (req.account && !req.account.perms.all && !req.account.perms.upload_image && !req.account.perms.upload_image_private) {
                        return res.status(HTTPCodes.FORBIDDEN)
                            .json({
                                status: HTTPCodes.FORBIDDEN,
                                message: `missing scope(s) ${pkg.name}-${req.config.env}:upload_image or ${pkg.name}-${req.config.env}:upload_image_private`,
                            });
                    }
                    // if a user tried to upload a non private image and does not have the needed scope
                    if (!req.body.hidden &&
                        req.body.hidden !== 'true') {
                        if (req.account && !req.account.perms.all && !req.account.perms.upload_image) {
                            return res.status(HTTPCodes.FORBIDDEN)
                                .json({
                                    status: HTTPCodes.FORBIDDEN,
                                    message: `missing scope ${pkg.name}-${req.config.env}:upload_image`,
                                });
                        }
                    }
                    if (req.body.campaignId && req.body.campaingId !== '') {
                        if (req.account && !req.account.perms.all && !req.account.perms.upload_campaign) {
                            return res.status(HTTPCodes.FORBIDDEN)
                                .json({
                                    status: HTTPCodes.FORBIDDEN,
                                    message: `missing scope ${pkg.name}-${req.config.env}:upload_campaign`,
                                });
                        } else {
                            campaign = await CampaignModel.findOne({ id: req.body.campaignId });
                            if (!campaign) {
                                return res.status(HTTPCodes.NOT_FOUND)
                                    .json({
                                        status: HTTPCodes.NOT_FOUND,
                                        message: `There is no campaign created with the id ${req.body.campaignId}`,
                                    });
                            }
                        }
                    }
                    // stop the request if no actual file/data is present
                    if (!req.body.url && !req.file) {
                        return res.status(400)
                            .json({ status: 400, message: 'You have to either pass a file or a url' });
                    }
                    req.body.baseType = req.body.baseType ? req.body.baseType : req.body.basetype;
                    if (!req.body.baseType) {
                        return res.status(400)
                            .json({ status: 400, message: 'You have to pass the basetype of the file' });
                    }
                    let uploadedFile;
                    let name_append = req.body.campaignId ? `-${req.body.campaignId}-x` : '';
                    if (req.file) {
                        // only allow certain image files
                        try {
                            this.checkImageType(req.file.mimetype);
                        } catch (e) {
                            return res.status(400)
                                .json({
                                    status: 400,
                                    message: `The mimetype ${req.file.mimetype} is not supported`,
                                });
                        }
                        // upload the file
                        uploadedFile = await req.storageProvider.upload(req.file.buffer, req.file.mimetype, name_append);
                    } else if (req.body.url) {
                        try {
                            // make a head request to the provided url
                            let url = Url.parse(req.body.url);
                            let head = await axios.head(url.href);
                            // check the file
                            try {
                                this.checkImageType(head.headers['content-type']);
                            } catch (e) {
                                return res.status(400)
                                    .json({
                                        status: 400,
                                        message: `The mimetype ${head.headers['content-type']} is not supported`,
                                    });
                            }
                            let request = await axios.get(url.href, {responseType: 'arraybuffer'});
                            uploadedFile = await req.storageProvider.upload(request.data, request.headers['content-type'], name_append);
                        } catch (e) {
                            winston.error(e);
                            return res.status(400)
                                .json({
                                    status: 400,
                                    message: `The url ${req.body.url} is not supported.`,
                                });
                        }
                    }
                    let hidden = false;
                    if (req.body.hidden) {
                        hidden = req.body.hidden === 'true';
                    }
                    let tags = [];
                    if (req.body.tags) {
                        tags = req.body.tags.split(',')
                            .map(t => {
                                t = t.trim();
                                return {name: t, hidden, user: req.account.id};
                            });
                    }
                    let nsfw = false;
                    if (req.body.nsfw) {
                        // support booleans for nsfw
                        // when nsfw is not true it will get set to false automatically :D
                        nsfw = req.body.nsfw === 'true';
                    }
                    let image = new ImageModel({
                        id: uploadedFile.name,
                        source: req.body.source ? req.body.source : undefined,
                        tags,
                        baseType: req.body.baseType,
                        fileType: uploadedFile.type,
                        mimeType: `image/${uploadedFile.type}`,
                        nsfw,
                        hidden,
                        account: req.account.id,
                        campaignId: req.body.campaignId,
                    });
                    await image.save();
                    if (campaign) {
                        await redirectController.createRedirect(image, campaign, req.storageProvider);
                    }
                    // build a full path with url
                    let imagePath = this.buildImagePath(req, req.config.provider.storage, image, campaign);
                    // send the success request to the client
                    return res.status(HTTPCodes.OK)
                        .json({
                            status: HTTPCodes.OK,
                            file: {
                                id: image.id,
                                fileType: image.fileType,
                                source: image.source,
                                baseType: image.baseType,
                                tags: image.tags,
                                url: imagePath,
                                hidden,
                                nsfw,
                                account: req.account.id,
                                campaignId: req.body.campaignId,
                            },
                            message: 'Upload succeeded',
                        });
                } catch (e) {
                    winston.error(e);
                    return res.status(HTTPCodes.INTERNAL_SERVER_ERROR)
                        .json({status: HTTPCodes.INTERNAL_SERVER_ERROR, message: 'Internal error'});
                }
            });
        this.get('/types', async (req) => {
            try {
                if (req.account && !req.account.perms.all && !req.account.perms.image_data) {
                    return {
                        status: HTTPCodes.FORBIDDEN,
                        message: `missing scope ${pkg.name}-${req.config.env}:image_data`,
                    };
                }
                let query = {};
                if (req.query.hidden) {
                    switch (req.query.hidden) {
                        case 'false':
                            query.hidden = false;
                            break;
                        case 'true':
                            query.hidden = true;
                            query.account = req.account.id;
                            break;
                        default:
                            break;
                    }
                } else {
                    query = {$or: [{hidden: false}, {account: req.account.id, hidden: true}]};
                }
                // switch through the nsfw types
                if (req.query.nsfw) {
                    switch (req.query.nsfw) {
                        case 'false':
                            query.nsfw = false;
                            break;
                        case 'true':
                            break;
                        case 'only':
                            query.nsfw = true;
                            break;
                        default:
                            query.nsfw = false;
                            break;
                    }
                } else {
                    query.nsfw = false;
                }
                let types = await ImageModel.distinct('baseType', query);
                let preview = [];
                if (req.query.preview) {
                    for (let type of types) {
                        query.baseType = type;
                        let image = await ImageModel.findOne(query, {id: 1, baseType: 1, fileType: 1})
                            .lean()
                            .exec();
                        if (image) {
                            image.url = this.buildImagePath(req, req.config.provider.storage, image);
                            preview.push({
                                url: image.url,
                                id: image.id,
                                fileType: image.fileType,
                                baseType: type,
                                type
                            });
                        }
                    }
                }
                return {status: 200, types: types, preview};
            } catch (e) {
                winston.error(e);
                return {status: HTTPCodes.INTERNAL_SERVER_ERROR, message: 'Internal error'};
            }
        });

        this.get('/tags', async (req) => {
            try {
                if (req.account && !req.account.perms.all && !req.account.perms.image_data) {
                    return {
                        status: HTTPCodes.FORBIDDEN,
                        message: `missing scope ${pkg.name}-${req.config.env}:image_data`,
                    };
                }
                let query = {};
                if (req.query.hidden) {
                    switch (req.query.hidden) {
                        case 'false':
                            query.hidden = false;
                            break;
                        case 'true':
                            query.hidden = true;
                            query.user = req.account.id;
                            break;
                        default:
                            break;
                    }
                } else {
                    query = {$or: [{'tags.hidden': false}, {'tags.user': req.account.id, 'tags.hidden': true}]};
                }
                // switch through the nsfw types
                if (req.query.nsfw) {
                    switch (req.query.nsfw) {
                        case 'false':
                            query.nsfw = false;
                            break;
                        case 'true':
                            break;
                        case 'only':
                            query.nsfw = true;
                            break;
                        default:
                            query.nsfw = false;
                            break;
                    }
                } else {
                    query.nsfw = false;
                }
                let tags = await ImageModel.distinct('tags.name', query);
                return {status: HTTPCodes.OK, tags};
            } catch (e) {
                winston.error(e);
                return {status: HTTPCodes.INTERNAL_SERVER_ERROR, message: 'Internal error'};
            }
        });

        this.get('/random', async (req) => {
            try {
                if (req.account && !req.account.perms.all && !req.account.perms.image_data) {
                    return {
                        status: HTTPCodes.FORBIDDEN,
                        message: `missing scope ${pkg.name}-${req.config.env}:image_data`,
                    };
                }
                let query = {};
                if (!req.query.type && !req.query.tags) {
                    return {status: 400, message: 'Missing parameters, add either type or tags'};
                }
                if (req.query.type) {
                    query.baseType = req.query.type;
                }
                // if there are tags split them and add them
                if (req.query.tags) {
                    let tags = req.query.tags.split(',');
                    tags = tags.map(t => {
                        t = t.trim();
                        return t;
                    });
                    query.tags = {
                        $elemMatch: {
                            $or: [{name: {$in: tags}, hidden: false}, {
                                name: {$in: tags},
                                hidden: true,
                                user: req.account.id,
                            }],
                        },
                    };
                }
                // switch through the nsfw types
                if (req.query.nsfw) {
                    switch (req.query.nsfw) {
                        case 'false':
                            query.nsfw = false;
                            break;
                        case 'true':
                            break;
                        case 'only':
                            query.nsfw = true;
                            break;
                        default:
                            query.nsfw = false;
                            break;
                    }
                } else {
                    query.nsfw = false;
                }
                if (req.query.hidden) {
                    switch (req.query.hidden) {
                        case 'false':
                            query.hidden = false;
                            break;
                        case 'true':
                            query.hidden = true;
                            query.account = req.account.id;
                            break;
                        default:
                            query.$or = [{hidden: false}, {hidden: true, account: req.account.id}];
                            break;
                    }
                } else {
                    query.$or = [{hidden: false}, {hidden: true, account: req.account.id}];
                }
                if (req.query.filetype) {
                    switch (req.query.filetype) {
                        case 'jpg':
                        case 'jpeg':
                            query.fileType = {$in: ['jpeg', 'jpg']};
                            break;
                        case 'png':
                            query.fileType = 'png';
                            break;
                        case 'gif':
                            query.fileType = 'gif';
                            break;
                        default:
                            break;
                    }
                }
                let campaign;
                let campaigns = await CampaignModel.find({ $query: { active: true }, $orderby: { probability: 1 } })
                    .lean()
                    .exec();
                for (let i = 0; i < campaigns.length; i++) {
                    if (this.checkCampaignTrigger(campaigns[i].probability)) {
                        campaign = campaigns[i];
                        break;
                    }
                }
                if (campaign) {
                    query.campaignId = campaign.id;
                }
                let images = await ImageModel.find(query)
                    .distinct('id');
                if (images.length === 0 && campaign) {
                    delete query.campaignId;
                    campaign = undefined;
                    images = await ImageModel.find(query)
                        .distinct('id');
                }
                if (images.length === 0) {
                    return { status: 404, message: 'No image found for your query' };
                }
                let id = images[Math.floor(Math.random() * images.length)];
                let image = await ImageModel.findOne({ id })
                    .lean()
                    .exec();
                if (!image) {
                    return { status: 404, message: 'No image found for your query' };
                }
                if (image.tags && image.tags.length > 0) {
                    image.tags = this.filterHiddenTags(image, req.account);
                }
                // build the full url to the image
                let imagePath = this.buildImagePath(req, req.config.provider.storage, image, campaign);
                // return the image
                if (campaign) {
                    delete campaign._id;
                    delete campaign.__v;
                    if (req.track) {
                        req.track.exec(req, { cs: campaign.source, ci: campaign.id });
                    }
                }
                return {
                    status: 200,
                    id: image.id,
                    type: image.baseType,
                    baseType: image.baseType,
                    nsfw: image.nsfw,
                    fileType: image.fileType,
                    mimeType: image.mimeType,
                    account: image.account,
                    hidden: image.hidden,
                    tags: image.tags,
                    url: imagePath,
                    campaign,
                };
            } catch (e) {
                winston.error(e);
                return {status: 500, message: 'Internal error'};
            }
        });
        this.get('/info', async () => ({status: 400, message: 'Missing parameters, you need to add an id'}));
        this.get('/info/:id', async (req) => {
            try {
                if (req.account && !req.account.perms.all && !req.account.perms.image_data) {
                    return {
                        status: HTTPCodes.FORBIDDEN,
                        message: `missing scope ${pkg.name}-${req.config.env}:image_data`,
                    };
                }
                let image = await ImageModel.findOne({id: req.params.id});
                if (!image) {
                    return {status: 404, message: 'No image found for your query'};
                }
                if (image.hidden && image.account !== req.account.id) {
                    return {status: HTTPCodes.FORBIDDEN, message: 'This image is private'};
                }
                if (image.tags && image.tags.length > 0) {
                    image.tags = this.filterHiddenTags(image, req.account);
                }
                let imagePath = this.buildImagePath(req, req.config.provider.storage, image);
                try {
                    await req.storageProvider.getFile(imagePath, `${image.id}.${image.fileType}`);
                } catch (e) {
                    return {status: 404, message: 'Image exists in Database but not in Filestorage'};
                }

                // return the image
                return {
                    status: 200,
                    id: image.id,
                    type: image.baseType,
                    baseType: image.baseType,
                    nsfw: image.nsfw,
                    fileType: image.fileType,
                    mimeType: image.mimeType,
                    tags: image.tags,
                    url: imagePath,
                    hidden: image.hidden,
                    account: image.account,
                };
            } catch (e) {
                winston.error(e);
                return {status: 500, message: 'Internal error'};
            }
        });
        this.post('/info/:id/tags', async (req) => {
            try {
                if (req.account && !req.account.perms.all && !req.account.perms.image_tags) {
                    return {
                        status: HTTPCodes.FORBIDDEN,
                        message: `missing scope ${pkg.name}-${req.config.env}:image_tags`,
                    };
                }
                let image = await ImageModel.findOne({id: req.params.id});
                if (!image) {
                    return {status: 404, message: 'No image found for your query'};
                }
                if (!req.body.tags) {
                    return {status: 400, message: 'No tags were supplied'};
                }
                if (image.hidden && image.account !== req.account.id) {
                    return {status: HTTPCodes.FORBIDDEN, message: 'This image is private'};
                }
                let tags;
                try {
                    tags = this.filterTags(req.body.tags, image.tags, req.account.id);
                } catch (e) {
                    return {status: 400, message: e.message};
                }
                if (tags.addedTags.length === 0) {
                    return {status: 400, message: 'Tags existed already or had no content'};
                }
                for (let tag of tags.addedTags) {
                    image.tags.push(tag);
                }
                await image.save();
                return {status: 200, image, tags};
            } catch (e) {
                winston.error(e);
                return {status: 500, message: 'Internal error'};
            }
        });
        this.delete('/info/:id/tags', async (req) => {
            try {
                if (req.account && !req.account.perms.all && !req.account.perms.image_tags_delete) {
                    return {
                        status: HTTPCodes.FORBIDDEN,
                        message: `missing scope ${pkg.name}-${req.config.env}:image_tags_delete`,
                    };
                }
                if (!req.body.tags) {
                    return {status: 400, message: 'No tags were supplied'};
                }
                let image = await ImageModel.findOne({id: req.params.id});
                if (image.hidden && image.account !== req.account.id) {
                    return {status: HTTPCodes.FORBIDDEN, message: 'This image is private'};
                }
                let tags = [];
                for (let tag of req.body.tags) {
                    let tagContent = this.getTagContent(tag);
                    if (!tagContent) {
                        continue;
                    }
                    tags.push(tagContent.toLocaleLowerCase());
                }
                // only return tags that should not be removed;
                image.tags = image.tags.filter((t) => tags.indexOf(t.name.toLocaleLowerCase()) <= -1);
                await image.save();
                return {status: 200, image};
            } catch (e) {
                winston.error(e);
                return {status: 500, message: 'Internal error'};
            }
        });
        this.delete('/info/:id', async (req) => {
            try {
                if (req.account && !req.account.perms.all && !req.account.perms.image_delete && !req.account.perms.image_delete_private) {
                    return {
                        status: HTTPCodes.FORBIDDEN,
                        message: `missing scope(s) ${pkg.name}-${req.config.env}:image_delete or ${pkg.name}-${req.config.env}:image_delete_private`,
                    };
                }
                if (!req.params.id) {
                    return {status: 400, message: 'Missing parameters, you need to add an id'};
                }
                let image = await ImageModel.findOne({id: req.params.id});
                if (!image) {
                    return { status: 404, message: 'No image found for your query' };
                }
                if (!image.hidden || (image.hidden && image.account !== req.account.id)) {
                    if (!req.account.perms.all && !req.account.perms.image_delete) {
                        return {
                            status: HTTPCodes.FORBIDDEN,
                            message: `missing scope ${pkg.name}-${req.config.env}:image_delete`,
                        };
                    }
                }
                let name_append = image.campaignId ? `-${image.campaignId}-x` : '';
                await req.storageProvider.removeFile(image, name_append);
                await ImageModel.remove({ id: image.id });
                return { status: 200, message: `Image successfully removed`, image: image };
            } catch (e) {
                winston.error(e);
                return {status: 500, message: 'Internal error'};
            }
        });
        this.get('/list/', async (req) => {
            try {
                if (!req.account.perms.all && !req.account.perms.image_list_all) {
                    return {
                        status: HTTPCodes.FORBIDDEN,
                        message: `missing scope(s) ${pkg.name}-${req.config.env}:image_list_all`,
                    };
                }
                let page = 0;
                let query = {};
                if (req.query.page) {
                    try {
                        req.query.page = parseInt(req.query.page);
                    } catch (e) {
                        winston.warn(e);
                    }
                    if (!isNaN(req.query.page)) {
                        page = req.query.page - 1;
                    } else {
                        page = 0;
                    }
                }
                if (page < 0) {
                    page = 0;
                }
                if (req.query.type) {
                    query.baseType = req.query.type;
                }
                if (req.query.nsfw) {
                    switch (req.query.nsfw) {
                        case 'false':
                            query.nsfw = false;
                            break;
                        case 'true':
                            break;
                        case 'only':
                            query.nsfw = true;
                            break;
                        default:
                            break;
                    }
                }
                if (req.query.hidden) {
                    switch (req.query.hidden) {
                        case 'false':
                            query.hidden = false;
                            break;
                        case 'true':
                            query.hidden = true;
                            break;
                        default:
                            break;
                    }
                }
                if (req.query.filetype) {
                    switch (req.query.filetype) {
                        case 'jpg':
                        case 'jpeg':
                            query.fileType = {$in: ['jpeg', 'jpg']};
                            break;
                        case 'png':
                            query.fileType = 'png';
                            break;
                        case 'gif':
                            query.fileType = 'gif';
                            break;
                        default:
                            break;
                    }
                }
                let totalImages = await ImageModel.count(query);
                let images = await ImageModel.find(query)
                    .skip(page * 25)
                    .limit(25)
                    .lean()
                    .exec();
                images = images.map(img => {
                    img.url = this.buildImagePath(req, req.config.provider.storage, img);
                    return img;
                });
                return {images, total: totalImages, page: page + 1};
            } catch (e) {
                winston.error(e);
                return {status: 500, message: 'Internal error'};
            }
        });
        this.get('/list/:id', async (req) => {
            try {
                if (req.account && !req.account.perms.all && !req.account.perms.image_list_all && !req.account.perms.image_list) {
                    return {
                        status: HTTPCodes.FORBIDDEN,
                        message: `missing scope(s) ${pkg.name}-${req.config.env}:image_list or ${pkg.name}-${req.config.env}:image_list_all`,
                    };
                }
                if (req.params.id !== req.account.id && !req.account.perms.all && !req.account.perms.image_list_all) {
                    return {
                        status: HTTPCodes.FORBIDDEN,
                        message: `missing scope ${pkg.name}-${req.config.env}:image_list_all`,
                    };
                }
                let page = 0;
                let query = {account: req.params.id};
                if (req.query.page) {
                    try {
                        req.query.page = parseInt(req.query.page);
                    } catch (e) {
                        winston.warn(e);
                    }
                    if (!isNaN(req.query.page)) {
                        page = req.query.page - 1;
                    } else {
                        page = 0;
                    }
                }
                if (page < 0) {
                    page = 0;
                }
                if (req.query.type) {
                    query.baseType = req.query.type;
                }
                if (req.query.nsfw) {
                    switch (req.query.nsfw) {
                        case 'false':
                            query.nsfw = false;
                            break;
                        case 'true':
                            break;
                        case 'only':
                            query.nsfw = true;
                            break;
                        default:
                            break;
                    }
                }
                if (req.query.hidden) {
                    switch (req.query.hidden) {
                        case 'false':
                            query.hidden = false;
                            break;
                        case 'true':
                            query.hidden = true;
                            break;
                        default:
                            break;
                    }
                }
                if (req.query.filetype) {
                    switch (req.query.filetype) {
                        case 'jpg':
                        case 'jpeg':
                            query.fileType = {$in: ['jpeg', 'jpg']};
                            break;
                        case 'png':
                            query.fileType = 'png';
                            break;
                        case 'gif':
                            query.fileType = 'gif';
                            break;
                        default:
                            break;
                    }
                }
                let totalImages = await ImageModel.count(query);
                let images = await ImageModel.find(query)
                    .skip(page * 25)
                    .limit(25)
                    .lean()
                    .exec();
                images = images.map(img => {
                    img.url = this.buildImagePath(req, req.config.provider.storage, img);
                    return img;
                });
                return {images, total: totalImages, page: page + 1};
            } catch (e) {
                winston.error(e);
                return {status: 500, message: 'Internal error'};
            }
        });
    }

    checkImageType(type) {
        switch (type) {
            case 'image/jpg':
            case 'image/jpeg':
                break;
            case 'image/png':
                break;
            case 'image/gif':
                break;
            default:
                throw new Error(`Filetype ${type} is not supported`);
        }
    }

    checkCampaignTrigger(probability) {
        let res = Math.floor(Math.random() * 100);
        return res <= probability;
    }

    // eslint-disable-next-line valid-jsdoc
    /**
     * Builds the actual path from the file
     * @param {Object} req the actual request
     * @param {Object} config the loaded config
     * @param {Object} image Image object
     * @param {Object} campaign Campaign object
     * @returns {string} imagePath Path to the image
     */
    buildImagePath(req, config, image, campaign) {
        let append = campaign ? `-${campaign.id}-x` : '';
        let imagePath;
        if (config.cdnurl && (!config.local || !config.local.serveFiles)) {
            imagePath = `${config.cdnurl}${config.cdnurl.endsWith('/') ? '' : '/'}${config.storagepath !== '' ? config.storagepath.endsWith('/') ? config.storagepath : `${config.storagepath}/` : ''}${image.id + append}.${image.fileType}`;
            return imagePath;
        }
        let fullUrl = `${req.protocol}://${req.get('host')}`;
        if (config.local && config.local.serveFiles) {
            imagePath = `${fullUrl}${config.local.servePath}${config.local.servePath.endsWith('/') ? '' : '/'}${image.id + append}.${image.fileType}`;
        }
        return imagePath;
    }

    filterTags(submittedTags, imageTags, accountId) {
        let addedTags = [];
        let skippedTags = [];
        for (let tag of submittedTags) {
            let tagContent = this.getTagContent(tag);
            if (!tagContent) {
                skippedTags.push('Tag without content');
            }
            if (this.checkTagExist(tag, imageTags)) {
                skippedTags.push(tag);
                continue;
            }
            let sanitizedTag = {user: accountId};
            if (typeof tag === 'string') {
                sanitizedTag = {hidden: false, user: accountId, name: tagContent};
            }
            if (!tag.name && typeof tag !== 'string') {
                throw new Error('Expected tags to contain array of strings or array of tag objects');
            }
            sanitizedTag.name = tagContent;
            if (!tag.hidden) {
                sanitizedTag.hidden = false;
            }
            addedTags.push(sanitizedTag);
        }
        return {addedTags, skippedTags};
    }

    /**
     * Utility method that checks if a tag already exists within an image
     * @param {string|Object} tag - User submitted tag, may either be an object or a method
     * @param {Array} imageTags - Array of tag objects
     * @returns {boolean} returns true if the tag exists and false if not
     */
    checkTagExist(tag, imageTags) {
        let tagContent = this.getTagContent(tag);
        for (let imageTag of imageTags) {
            if (imageTag.name.toLocaleLowerCase() === tagContent.toLocaleLowerCase()) {
                return true;
            }
        }
        return false;
    }

    /**
     * Utility method that returns the content of a tag with whitespace removed
     * @param {Object|string} tag - User submitted tag, may either be an object or a method
     * @returns {string|null} content of the tag or null if the tag had no content
     */
    getTagContent(tag) {
        if (typeof tag !== 'string') {
            if (!tag.name) {
                return null;
            } else {
                return tag.name.trim();
            }
        } else {
            return tag.trim();
        }
    }

    /**
     * Filters out tags to only show the tags a user may see
     * @param {Object} image - The Image that should be filtered
     * @param {Object} account - The account that made the request
     * @returns {Object} - Image with filtered tags
     */
    filterHiddenTags(image, account) {
        return image.tags.filter(t => {
            if (t.hidden && t.user === account.id) {
                return true;
            }
            return !t.hidden;
        });
    }
}

module.exports = ImageRouter;
