#!/usr/bin/env node

import { zKey, r1cs } from "snarkjs"
import boxen from "boxen"
import { createWriteStream, Dirent, renameSync } from "fs"
import {
    blake512FromPath,
    isCoordinator,
    extractPrefix,
    commonTerms,
    potFilenameTemplate,
    genesisZkeyIndex,
    getR1csStorageFilePath,
    getPotStorageFilePath,
    getZkeyStorageFilePath,
    extractPoTFromFilename,
    potFileDownloadMainUrl,
    getBucketName,
    createS3Bucket,
    multiPartUpload,
    objectExist,
    setupCeremony,
    extractCircuitMetadata
} from "@zkmpc/actions/src"
import { CeremonyTimeoutType } from "@zkmpc/actions/src/types/enums"
import {
    CeremonyInputData,
    CircomCompilerData,
    CircuitArtifacts,
    CircuitDocument,
    CircuitInputData,
    CircuitTimings
} from "@zkmpc/actions/src/types"
import { pipeline } from "node:stream"
import { promisify } from "node:util"
import fetch from "node-fetch"
import { Functions } from "firebase/functions"
import {
    convertToDoubleDigits,
    createCustomLoggerForFile,
    customSpinner,
    simpleLoader,
    sleep,
    terminate
} from "../lib/utils"
import {
    promptCeremonyInputData,
    promptCircomCompiler,
    promptCircuitInputData,
    askForConfirmation,
    promptCircuitSelector,
    promptSameCircomCompiler,
    promptCircuitAddition,
    promptPreComputedZkey,
    promptPreComputedZkeySelector,
    promptNeededPowersForCircuit,
    promptPotSelector,
    promptZkeyGeneration
} from "../lib/prompts"
import { COMMAND_ERRORS, showError } from "../lib/errors"
import { bootstrapCommandExecutionAndServices, checkAuth } from "../lib/services"
import {
    getCWDFilePath,
    getMetadataLocalFilePath,
    getPotLocalFilePath,
    getZkeyLocalFilePath,
    localPaths
} from "../lib/localConfigs"
import theme from "../lib/theme"
import {
    filterDirectoryFilesByExtension,
    cleanDir,
    getDirFilesSubPaths,
    getFileStats,
    checkAndMakeNewDirectoryIfNonexistent
} from "../lib/files"

/**
 * Handle whatever is needed to obtain the input data for a circuit that the coordinator would like to add to the ceremony.
 * @param choosenCircuitFilename <string> - the name of the circuit to add.
 * @param ceremonyTimeoutMechanismType <CeremonyTimeoutType> - the type of ceremony timeout mechanism.
 * @param sameCircomCompiler <boolean> - true, if this circuit shares with the others the <CircomCompilerData>; otherwise false.
 * @param circuitSequencePosition <number> - the position of the circuit in the contribution queue.
 * @param sharedCircomCompilerData <string> - version and commit hash of the Circom compiler used to compile the ceremony circuits.
 * @returns <Promise<CircuitInputData>> - the input data of the circuit to add to the ceremony.
 */
const getInputDataToAddCircuitToCeremony = async (
    choosenCircuitFilename: string,
    ceremonyTimeoutMechanismType: CeremonyTimeoutType,
    sameCircomCompiler: boolean,
    circuitSequencePosition: number,
    sharedCircomCompilerData: CircomCompilerData
): Promise<CircuitInputData> => {
    // Prompt for circuit input data.
    const circuitInputData = await promptCircuitInputData(ceremonyTimeoutMechanismType, sameCircomCompiler)

    // Extract name and prefix.
    const circuitName = choosenCircuitFilename.substring(0, choosenCircuitFilename.indexOf("."))
    const circuitPrefix = extractPrefix(circuitName)

    // R1CS circuit file path.
    const r1csMetadataLocalFilePath = getMetadataLocalFilePath(
        `${circuitPrefix}_${commonTerms.foldersAndPathsTerms.metadata}.log`
    )
    const r1csCWDFilePath = getCWDFilePath(process.cwd(), choosenCircuitFilename)

    // Prepare a custom logger for R1CS metadata store (from snarkjs console to file).
    const logger = createCustomLoggerForFile(r1csMetadataLocalFilePath)

    const spinner = customSpinner(`Looking for circuit metadata...`, "clock")
    spinner.start()

    // Read R1CS and store metadata locally.
    // @todo need to investigate the behaviour of this info() method with huge circuits (could be a pain).
    await r1cs.info(r1csCWDFilePath, logger)

    await sleep(2000) // Sleep 2s to avoid unexpected termination (file descriptor close).

    spinner.succeed(`Circuit metadata read and saved correctly\n`)

    // Return updated data.
    return {
        ...circuitInputData,
        compiler: {
            commitHash:
                !circuitInputData.compiler.commitHash && sameCircomCompiler
                    ? sharedCircomCompilerData.commitHash
                    : circuitInputData.compiler.commitHash,
            version:
                !circuitInputData.compiler.version && sameCircomCompiler
                    ? sharedCircomCompilerData.version
                    : circuitInputData.compiler.version
        },
        name: circuitName,
        prefix: circuitPrefix,
        sequencePosition: circuitSequencePosition
    }
}

/**
 * Handle the addition of one or more circuits to the ceremony.
 * @param options <Array<string>> - list of possible circuits that can be added to the ceremony.
 * @param ceremonyTimeoutMechanismType <CeremonyTimeoutType> - the type of ceremony timeout mechanism.
 * @returns <Promise<Array<CircuitInputData>>> - the input data for each circuit that has been added to the ceremony.
 */
const handleAdditionOfCircuitsToCeremony = async (
    options: Array<string>,
    ceremonyTimeoutMechanismType: CeremonyTimeoutType
): Promise<Array<CircuitInputData>> => {
    // Prepare data.
    const circuitsInputData: Array<CircuitInputData> = [] // All circuits interactive data.
    let circuitSequencePosition = 1 // The circuit's position for contribution.
    let readyToSummarizeCeremony = false // Boolean flag to check whether the coordinator has finished to add circuits to the ceremony.
    let wannaAddAnotherCircuit = true // Loop flag.
    const sharedCircomCompilerData: CircomCompilerData = { version: "", commitHash: "" }

    // Prompt if the circuits to be added were compiled with the same version of Circom.
    // nb. CIRCOM compiler version/commit-hash is a declaration useful for later verifiability and avoid bugs.
    const sameCircomCompiler = await promptSameCircomCompiler()

    if (sameCircomCompiler) {
        // Prompt for Circom compiler.
        const { version, commitHash } = await promptCircomCompiler()

        sharedCircomCompilerData.version = version
        sharedCircomCompilerData.commitHash = commitHash
    }

    while (wannaAddAnotherCircuit) {
        // Gather information about the ceremony circuits.
        console.log(theme.text.bold(`\n- Circuit # ${theme.colors.magenta(`${circuitSequencePosition}`)}\n`))

        // Select one circuit among cwd circuits identified by R1CS files.
        const choosenCircuitFilename = await promptCircuitSelector(options)

        // Update list of possible options for next selection (if, any).
        options = options.filter((circuitFilename: string) => circuitFilename !== choosenCircuitFilename)

        // Get input data for choosen circuit.
        const circuitInputData = await getInputDataToAddCircuitToCeremony(
            choosenCircuitFilename,
            ceremonyTimeoutMechanismType,
            sameCircomCompiler,
            circuitSequencePosition,
            sharedCircomCompilerData
        )

        // Store circuit data.
        circuitsInputData.push(circuitInputData)

        // Check if any circuit is left for potentially addition to ceremony.
        if (options.length !== 0) {
            // Prompt for selection.
            const wannaAddNewCircuit = await promptCircuitAddition()

            if (wannaAddNewCircuit === false) readyToSummarizeCeremony = true // Terminate circuit addition.
            else circuitSequencePosition += 1 // Continue with next one.
        } else readyToSummarizeCeremony = true // No more circuit to add.

        // Summarize the ceremony.
        if (readyToSummarizeCeremony) wannaAddAnotherCircuit = false
    }

    return circuitsInputData
}

/**
 * Print ceremony and related circuits information.
 * @param ceremonyInputData <CeremonyInputData> - the input data of the ceremony.
 * @param circuits <Array<CircuitDocument>> - the circuit documents associated to the circuits of the ceremony.
 */
const displayCeremonySummary = (ceremonyInputData: CeremonyInputData, circuits: Array<CircuitDocument>) => {
    // Prepare ceremony summary.
    let summary = `${`${theme.text.bold(ceremonyInputData.title)}\n${theme.text.italic(ceremonyInputData.description)}`}
        \n${`Opening: ${theme.text.bold(
            theme.text.underlined(new Date(ceremonyInputData.startDate).toUTCString().replace("GMT", "UTC"))
        )}\nEnding: ${theme.text.bold(
            theme.text.underlined(new Date(ceremonyInputData.endDate).toUTCString().replace("GMT", "UTC"))
        )}`}
        \n${theme.text.bold(
            ceremonyInputData.timeoutMechanismType === CeremonyTimeoutType.DYNAMIC ? `Dynamic` : `Fixed`
        )} Timeout / ${theme.text.bold(ceremonyInputData.penalty)}m Penalty`

    for (const circuit of circuits) {
        // Append circuit summary.
        summary += `\n\n${theme.text.bold(
            `- CIRCUIT # ${theme.text.bold(theme.colors.magenta(`${circuit.sequencePosition}`))}`
        )}
      \n${`${theme.text.bold(circuit.name)}\n${theme.text.italic(circuit.description)}
      \nCurve: ${theme.text.bold(circuit.metadata?.curve)}\nCompiler: ${theme.text.bold(
          `${circuit.compiler.version}`
      )} (${theme.text.bold(circuit.compiler.commitHash.slice(0, 7))})\nSource: ${theme.text.bold(
          circuit.template.source.split(`/`).at(-1)
      )}(${theme.text.bold(circuit.template.paramsConfiguration)})\n${
          ceremonyInputData.timeoutMechanismType === CeremonyTimeoutType.DYNAMIC
              ? `Threshold: ${theme.text.bold(circuit.dynamicThreshold)}%`
              : `Max Contribution Time: ${theme.text.bold(circuit.fixedTimeWindow)}m`
      }
      \n# Wires: ${theme.text.bold(circuit.metadata?.wires)}\n# Constraints: ${theme.text.bold(
          circuit.metadata?.constraints
      )}\n# Private Inputs: ${theme.text.bold(circuit.metadata?.privateInputs)}\n# Public Inputs: ${theme.text.bold(
          circuit.metadata?.publicInputs
      )}\n# Labels: ${theme.text.bold(circuit.metadata?.labels)}\n# Outputs: ${theme.text.bold(
          circuit.metadata?.outputs
      )}\n# PoT: ${theme.text.bold(circuit.metadata?.pot)}`}`
    }

    // Display complete summary.
    console.log(
        boxen(summary, {
            title: theme.colors.magenta(`CEREMONY SUMMARY`),
            titleAlignment: "center",
            textAlignment: "left",
            margin: 1,
            padding: 1
        })
    )
}

/**
 * Check if the smallest Powers of Tau has already been downloaded/stored in the correspondent local path
 * @dev we are downloading the Powers of Tau file from Hermez Cryptography Phase 1 Trusted Setup.
 * @param powers <string> - the smallest amount of powers needed for the given circuit (should be in a 'XY' stringified form).
 * @param ptauCompleteFilename <string> - the complete file name of the powers of tau file to be downloaded.
 * @returns <Promise<void>>
 */
const checkAndDownloadSmallestPowersOfTau = async (powers: string, ptauCompleteFilename: string): Promise<void> => {
    // Get already downloaded ptau files.
    const alreadyDownloadedPtauFiles = await getDirFilesSubPaths(localPaths.pot)

    // Get the required smallest ptau file.
    const smallestPtauFileForGivenPowers: Array<string> = alreadyDownloadedPtauFiles
        .filter((dirent: Dirent) => extractPoTFromFilename(dirent.name) === Number(powers))
        .map((dirent: Dirent) => dirent.name)

    // Check if already downloaded or not.
    if (smallestPtauFileForGivenPowers.length === 0) {
        const spinner = customSpinner(
            `Downloading the ${theme.text.bold(
                `#${powers}`
            )} smallest PoT file needed from the Hermez Cryptography Phase 1 Trusted Setup...`,
            `clock`
        )
        spinner.start()

        // Download smallest Powers of Tau file from remote server.
        const streamPipeline = promisify(pipeline)

        // Make the call.
        const response = await fetch(`${potFileDownloadMainUrl}${ptauCompleteFilename}`)

        // Handle errors.
        if (!response.ok && response.status !== 200) showError(COMMAND_ERRORS.COMMAND_SETUP_DOWNLOAD_PTAU, true)
        // Write the file locally
        else await streamPipeline(response.body!, createWriteStream(getPotLocalFilePath(ptauCompleteFilename)))

        spinner.succeed(`Powers of tau ${theme.text.bold(`#${powers}`)} downloaded successfully`)
    } else
        console.log(
            `${theme.symbols.success} Smallest Powers of Tau ${theme.text.bold(`#${powers}`)} already downloaded`
        )
}

/**
 * Handle the needs in terms of Powers of Tau for the selected pre-computed zKey.
 * @notice in case there are no Powers of Tau file suitable for the pre-computed zKey (i.e., having a
 * number of powers greater than or equal to the powers needed by the zKey), the coordinator will be asked
 * to provide a number of powers manually, ranging from the smallest possible to the largest.
 * @param neededPowers <number> - the smallest amount of powers needed by the zKey.
 * @returns Promise<string, string> - the information about the choosen Powers of Tau file for the pre-computed zKey
 * along with related powers.
 */
const handlePreComputedZkeyPowersOfTauSelection = async (
    neededPowers: number
): Promise<{
    doubleDigitsPowers: string
    potCompleteFilename: string
    usePreDownloadedPoT: boolean
}> => {
    let doubleDigitsPowers: string = "" // The amount of stringified powers in a double-digits format (XY).
    let potCompleteFilename: string = "" // The complete filename of the Powers of Tau file selected for the pre-computed zKey.
    let usePreDownloadedPoT = false // Boolean flag to check if the coordinator is going to use a pre-downloaded PoT file or not.

    // Check for PoT file associated to selected pre-computed zKey.
    const spinner = customSpinner("Looking for Powers of Tau files...", "clock")
    spinner.start()

    // Get local `.ptau` files.
    const potFilePaths = await filterDirectoryFilesByExtension(process.cwd(), `.ptau`)

    // Filter based on suitable amount of powers.
    const potOptions: Array<string> = potFilePaths
        .filter((dirent: Dirent) => extractPoTFromFilename(dirent.name) >= neededPowers)
        .map((dirent: Dirent) => dirent.name)

    if (potOptions.length <= 0) {
        spinner.warn(`There is no already downloaded Powers of Tau file suitable for this zKey`)

        // Ask coordinator to input the amount of powers.
        const choosenPowers = await promptNeededPowersForCircuit(neededPowers)

        // Convert to double digits powers (e.g., 9 -> 09).
        doubleDigitsPowers = convertToDoubleDigits(choosenPowers)
        potCompleteFilename = `${potFilenameTemplate}${doubleDigitsPowers}.ptau`
    } else {
        spinner.stop()

        // Prompt for Powers of Tau selection among already downloaded ones.
        potCompleteFilename = await promptPotSelector(potOptions)

        // Convert to double digits powers (e.g., 9 -> 09).
        doubleDigitsPowers = convertToDoubleDigits(extractPoTFromFilename(potCompleteFilename))

        usePreDownloadedPoT = true
    }

    return {
        doubleDigitsPowers,
        potCompleteFilename,
        usePreDownloadedPoT
    }
}

/**
 * Handle the verification task for a pre-computed zKey.
 * @notice if the pre-computed zKey is invalid, the method prompts to the coordinator the generation for another zKey
 * from scratch. If not, the command will gracefully exit.
 * @dev this check is necessary to avoid to upload a wrong combination of R1CS, PoT and pre-computed zKey file.
 * @param r1csLocalPathAndFileName <string> - the local complete path of the R1CS selected file.
 * @param potLocalPathAndFileName <string> - the local complete path of the PoT selected file.
 * @param zkeyLocalPathAndFileName <string> - the local complete path of the pre-computed zKey selected file.
 * @returns <Promise<boolean>> - the validity of the pre-computed zKey.
 */
const handlePreComputedZkeyVerification = async (
    r1csLocalPathAndFileName: string,
    potLocalPathAndFileName: string,
    zkeyLocalPathAndFileName: string
): Promise<boolean> => {
    console.log(
        `${theme.symbols.info} Checking the pre-computed zKey locally on your machine (to avoid any R1CS, PoT, zKey combination errors)`
    )

    // Verify validity of pre-computed zKey (R1CS and PoT are implicitly verified).
    const valid = await zKey.verifyFromR1cs(
        r1csLocalPathAndFileName,
        potLocalPathAndFileName,
        zkeyLocalPathAndFileName,
        console
    )

    await sleep(3000) // workaround for unexpected file descriptor close.

    if (valid) console.log(`${theme.symbols.success} The provided pre-computed zKey has passed validation check`)
    else {
        console.log(`${theme.symbols.error} The provided pre-computed zKey is invalid!`)

        // Prompt to generate a new zKey from scratch.
        const newZkeyGeneration = await promptZkeyGeneration()

        if (!newZkeyGeneration) showError(COMMAND_ERRORS.COMMAND_SETUP_ABORT, true)
    }

    return valid
}

/**
 * Generate a brand new zKey from scratch.
 * @param r1csLocalPathAndFileName <string> - the local complete path of the R1CS selected file.
 * @param potLocalPathAndFileName <string> - the local complete path of the PoT selected file.
 * @param zkeyLocalPathAndFileName <string> - the local complete path of the pre-computed zKey selected file.
 */
const handleNewZkeyGeneration = async (
    r1csLocalPathAndFileName: string,
    potLocalPathAndFileName: string,
    zkeyLocalPathAndFileName: string
) => {
    console.log(
        `${theme.symbols.info} The computation of your brand new zKey is starting soon.\n${theme.text.bold(
            `${theme.symbols.warning} Be careful, stopping the process will result in the loss of all progress achieved so far.`
        )}`
    )

    // Generate zKey.
    await zKey.newZKey(r1csLocalPathAndFileName, potLocalPathAndFileName, zkeyLocalPathAndFileName, console)

    console.log(`\n${theme.symbols.success} Generation of genesis zKey completed successfully`)
}

/**
 * Manage the creation of a ceremony file storage bucket.
 * @param firebaseFunctions <Functions> - the Firebase Cloud Functions instance connected to the current application.
 * @param ceremonyPrefix <string> - the prefix of the ceremony.
 * @returns <Promise<string>> - the ceremony bucket name.
 */
const handleCeremonyBucketCreation = async (firebaseFunctions: Functions, ceremonyPrefix: string): Promise<string> => {
    // Compose bucket name using the ceremony prefix.
    const bucketName = getBucketName(ceremonyPrefix, process.env.CONFIG_CEREMONY_BUCKET_POSTFIX!)

    const spinner = customSpinner(`Getting ready for ceremony files and data storage...`, `clock`)
    spinner.start()

    try {
        // Make the call to create the bucket.
        await createS3Bucket(firebaseFunctions, bucketName)
    } catch (error: any) {
        const errorBody = JSON.parse(JSON.stringify(error))
        showError(`[${errorBody.code}] ${error.message} ${!errorBody.details ? "" : `\n${errorBody.details}`}`, true)
    }

    spinner.succeed(`Ceremony bucket has been successfully created`)

    return bucketName
}

/**
 * Upload a circuit artifact (R1CS, zKey, PoT) to ceremony storage bucket.
 * @dev this method leverages the AWS S3 multi-part upload under the hood.
 * @param firebaseFunctions <Functions> - the Firebase Cloud Functions instance connected to the current application.
 * @param bucketName <string> - the ceremony bucket name.
 * @param storageFilePath <string> - the storage (bucket) path where the file should be uploaded.
 * @param localPathAndFileName <string> - the local file path where is located.
 * @param completeFilename <string> - the complete filename.
 */
const handleCircuitArtifactUploadToStorage = async (
    firebaseFunctions: Functions,
    bucketName: string,
    storageFilePath: string,
    localPathAndFileName: string,
    completeFilename: string
) => {
    const spinner = customSpinner(`Uploading ${theme.text.bold(completeFilename)} file to ceremony storage...`, `clock`)
    spinner.start()

    await multiPartUpload(
        firebaseFunctions,
        bucketName,
        storageFilePath,
        localPathAndFileName,
        String(process.env.CONFIG_STREAM_CHUNK_SIZE_IN_MB),
        Number(process.env.CONFIG_PRESIGNED_URL_EXPIRATION_IN_SECONDS)
    )

    spinner.succeed(`Upload of (${theme.text.bold(completeFilename)}) file completed successfully`)
}

/**
 * Setup command.
 * @notice The setup command allows the coordinator of the ceremony to prepare the next ceremony by interacting with the CLI.
 * @dev For proper execution, the command must be run in a folder containing the R1CS files related to the circuits
 * for which the coordinator wants to create the ceremony. The command will download the necessary Tau powers
 * from Hermez's ceremony Phase 1 Reliable Setup Ceremony.
 */
const setup = async () => {
    // Setup command state.
    const circuits: Array<CircuitDocument> = [] // Circuits.

    const { firebaseApp, firebaseFunctions, firestoreDatabase } = await bootstrapCommandExecutionAndServices()

    // Check for authentication.
    const { user, handle } = await checkAuth(firebaseApp)

    // Preserve command execution only for coordinators.
    if (!(await isCoordinator(user))) showError(COMMAND_ERRORS.COMMAND_NOT_COORDINATOR, true)

    // Get current working directory.
    const cwd = process.cwd()

    console.log(
        `${theme.symbols.warning} To setup a zkSNARK Groth16 Phase 2 Trusted Setup ceremony you need to have the Rank-1 Constraint System (R1CS) file for each circuit in your working directory`
    )
    console.log(
        `\n${theme.symbols.info} Your current working directory is ${theme.text.bold(
            theme.text.underlined(process.cwd())
        )}\n`
    )

    // Look for R1CS files.
    const r1csFilePaths = await filterDirectoryFilesByExtension(cwd, `.r1cs`)
    // Look for pre-computed zKeys references (if any).
    const localPreComputedZkeysFilenames = await filterDirectoryFilesByExtension(cwd, `.zkey`)

    if (!r1csFilePaths.length) showError(COMMAND_ERRORS.COMMAND_SETUP_NO_R1CS, true)

    // Prepare local directories.
    checkAndMakeNewDirectoryIfNonexistent(localPaths.output)
    cleanDir(localPaths.setup)
    cleanDir(localPaths.pot)
    cleanDir(localPaths.metadata)
    cleanDir(localPaths.zkeys)

    // Prompt the coordinator for gather ceremony input data.
    const ceremonyInputData = await promptCeremonyInputData(firestoreDatabase)
    const ceremonyPrefix = extractPrefix(ceremonyInputData.title)

    // Add circuits to ceremony.
    const circuitsInputData: Array<CircuitInputData> = await handleAdditionOfCircuitsToCeremony(
        r1csFilePaths.map((dirent: Dirent) => dirent.name),
        ceremonyInputData.timeoutMechanismType
    )

    const spinner = customSpinner(`Summarizing your ceremony...`, "clock")
    spinner.start()

    // Extract circuits metadata.
    for (const circuitInputData of circuitsInputData) {
        // Read file which contains the circuit metadata.
        const r1csMetadataFilePath = getMetadataLocalFilePath(
            `${circuitInputData.prefix}_${commonTerms.foldersAndPathsTerms.metadata}.log`
        )

        const circuitMetadata = extractCircuitMetadata(r1csMetadataFilePath)

        circuits.push({
            ...circuitInputData,
            metadata: circuitMetadata
        })
    }

    spinner.stop()

    // Display ceremony summary.
    displayCeremonySummary(ceremonyInputData, circuits)

    // Prepare data.
    let wannaGenerateNewZkey = true // New zKey generation flag.
    let wannaUsePreDownloadedPoT = false // Local PoT file usage flag.
    let bucketName: string = "" // The name of the bucket.

    // Ask for confirmation.
    const { confirmation } = await askForConfirmation("Do you want to continue with the ceremony setup?", "Yes", "No")

    if (confirmation) {
        await simpleLoader(`Looking for any pre-computed zkey file...`, `clock`, 1000)

        // Simulate pre-computed zkeys search.
        let leftPreComputedZkeys = localPreComputedZkeysFilenames

        /** Circuit-based setup */
        for (let i = 0; i < circuits.length; i += 1) {
            const circuit = circuits[i]

            console.log(
                theme.text.bold(`\n- Setup for Circuit # ${theme.colors.magenta(`${circuit.sequencePosition}`)}\n`)
            )

            // Convert to double digits powers (e.g., 9 -> 09).
            let doubleDigitsPowers = convertToDoubleDigits(circuit.metadata?.pot!)
            let smallestPowersOfTauCompleteFilenameForCircuit = `${potFilenameTemplate}${doubleDigitsPowers}.ptau`

            // Rename R1Cs and zKey based on circuit name and prefix.
            const r1csCompleteFilename = `${circuit.name}.r1cs`
            const firstZkeyCompleteFilename = `${circuit.prefix}_${genesisZkeyIndex}.zkey`
            let preComputedZkeyCompleteFilename = ``

            // Local paths.
            const r1csLocalPathAndFileName = getCWDFilePath(cwd, r1csCompleteFilename)
            let potLocalPathAndFileName = getPotLocalFilePath(smallestPowersOfTauCompleteFilenameForCircuit)
            let zkeyLocalPathAndFileName = getZkeyLocalFilePath(firstZkeyCompleteFilename)

            // Storage paths.
            const r1csStorageFilePath = getR1csStorageFilePath(circuit.prefix!, r1csCompleteFilename)
            let potStorageFilePath = getPotStorageFilePath(smallestPowersOfTauCompleteFilenameForCircuit)
            const zkeyStorageFilePath = getZkeyStorageFilePath(circuit.prefix!, firstZkeyCompleteFilename)

            if (leftPreComputedZkeys.length <= 0)
                console.log(
                    `${theme.symbols.warning} No pre-computed zKey was found. Therefore, a new zKey from scratch will be generated.`
                )
            else {
                // Prompt if coordinator wanna use a pre-computed zKey for the circuit.
                const wannaUsePreComputedZkey = await promptPreComputedZkey()

                if (wannaUsePreComputedZkey) {
                    // Prompt for pre-computed zKey selection.
                    const preComputedZkeyOptions = leftPreComputedZkeys.map((dirent: Dirent) => dirent.name)
                    preComputedZkeyCompleteFilename = await promptPreComputedZkeySelector(preComputedZkeyOptions)

                    // Switch to pre-computed zkey path.
                    zkeyLocalPathAndFileName = getCWDFilePath(cwd, preComputedZkeyCompleteFilename)

                    // Handle the selection for the PoT file to associate w/ the selected pre-computed zKey.
                    const {
                        doubleDigitsPowers: selectedDoubleDigitsPowers,
                        potCompleteFilename: selectedPotCompleteFilename,
                        usePreDownloadedPoT
                    } = await handlePreComputedZkeyPowersOfTauSelection(circuit.metadata?.pot!)

                    // Update state.
                    doubleDigitsPowers = selectedDoubleDigitsPowers
                    smallestPowersOfTauCompleteFilenameForCircuit = selectedPotCompleteFilename
                    wannaUsePreDownloadedPoT = usePreDownloadedPoT

                    // Update paths.
                    potLocalPathAndFileName = getPotLocalFilePath(smallestPowersOfTauCompleteFilenameForCircuit)
                    potStorageFilePath = getPotStorageFilePath(smallestPowersOfTauCompleteFilenameForCircuit)

                    // Check (and download) the smallest Powers of Tau for circuit.
                    if (!wannaUsePreDownloadedPoT)
                        await checkAndDownloadSmallestPowersOfTau(
                            doubleDigitsPowers,
                            smallestPowersOfTauCompleteFilenameForCircuit
                        )

                    // Check if the pre-computed zKey (in combination w/ PoT + R1CS files) is valid.
                    const isPreComputedZkeyValid = await handlePreComputedZkeyVerification(
                        r1csLocalPathAndFileName,
                        potLocalPathAndFileName,
                        zkeyLocalPathAndFileName
                    )

                    // Update flag for zKey generation accordingly.
                    wannaGenerateNewZkey = !isPreComputedZkeyValid

                    // If pre-computed zKey + combination of R1CS and PoT are valid.
                    if (isPreComputedZkeyValid) {
                        // Update paths.
                        renameSync(getCWDFilePath(cwd, preComputedZkeyCompleteFilename), firstZkeyCompleteFilename) // the pre-computed zKey become the new first (genesis) zKey.
                        zkeyLocalPathAndFileName = getCWDFilePath(cwd, firstZkeyCompleteFilename)

                        // Remove the pre-computed zKey from the list of possible pre-computed options.
                        leftPreComputedZkeys = leftPreComputedZkeys.filter(
                            (dirent: Dirent) => dirent.name !== preComputedZkeyCompleteFilename
                        )
                    }
                }
            }

            // Check (and download) the smallest Powers of Tau for circuit.
            if (!wannaUsePreDownloadedPoT)
                await checkAndDownloadSmallestPowersOfTau(
                    doubleDigitsPowers,
                    smallestPowersOfTauCompleteFilenameForCircuit
                )

            if (wannaGenerateNewZkey)
                await handleNewZkeyGeneration(
                    r1csLocalPathAndFileName,
                    potLocalPathAndFileName,
                    zkeyLocalPathAndFileName
                )

            // Create a bucket for ceremony if it has not yet been created.
            if (!bucketName) bucketName = await handleCeremonyBucketCreation(firebaseFunctions, ceremonyPrefix)

            // Upload zKey to Storage.
            await handleCircuitArtifactUploadToStorage(
                firebaseFunctions,
                bucketName,
                zkeyStorageFilePath,
                zkeyLocalPathAndFileName,
                firstZkeyCompleteFilename
            )

            // Check if PoT file has been already uploaded to storage.
            const alreadyUploadedPot = await objectExist(
                firebaseFunctions,
                bucketName,
                getPotStorageFilePath(smallestPowersOfTauCompleteFilenameForCircuit)
            )

            if (!alreadyUploadedPot) {
                // Upload PoT to Storage.
                await handleCircuitArtifactUploadToStorage(
                    firebaseFunctions,
                    bucketName,
                    potStorageFilePath,
                    potLocalPathAndFileName,
                    smallestPowersOfTauCompleteFilenameForCircuit
                )
            } else
                console.log(
                    `${theme.symbols.success} The Powers of Tau (${theme.text.bold(
                        smallestPowersOfTauCompleteFilenameForCircuit
                    )}) file is already saved in the storage`
                )

            // Upload R1CS to Storage.
            await handleCircuitArtifactUploadToStorage(
                firebaseFunctions,
                bucketName,
                r1csStorageFilePath,
                r1csLocalPathAndFileName,
                r1csCompleteFilename
            )

            process.stdout.write(`\n`)

            spinner.text = `Preparing the ceremony data (this may take a while)...`
            spinner.start()

            // Computing file hash (this may take a while).
            const r1csBlake2bHash = await blake512FromPath(r1csLocalPathAndFileName)
            const potBlake2bHash = await blake512FromPath(potLocalPathAndFileName)
            const initialZkeyBlake2bHash = await blake512FromPath(zkeyLocalPathAndFileName)

            spinner.stop()

            // Prepare circuit data for writing to the DB.
            const circuitFiles: CircuitArtifacts = {
                r1csFilename: r1csCompleteFilename,
                potFilename: smallestPowersOfTauCompleteFilenameForCircuit,
                initialZkeyFilename: firstZkeyCompleteFilename,
                r1csStoragePath: r1csStorageFilePath,
                potStoragePath: potStorageFilePath,
                initialZkeyStoragePath: zkeyStorageFilePath,
                r1csBlake2bHash,
                potBlake2bHash,
                initialZkeyBlake2bHash
            }

            // nb. these will be populated after the first contribution.
            const circuitTimings: CircuitTimings = {
                contributionComputation: 0,
                fullContribution: 0,
                verifyCloudFunction: 0
            }

            circuits[i] = {
                ...circuit,
                files: circuitFiles,
                avgTimings: circuitTimings,
                zKeySizeInBytes: getFileStats(zkeyLocalPathAndFileName).size
            }

            // Reset flags.
            wannaGenerateNewZkey = true
            wannaUsePreDownloadedPoT = false
        }

        spinner.text = `Writing ceremony data...`
        spinner.start()

        try {
            // Call the Cloud Function for writing ceremony data on Firestore DB.
            await setupCeremony(firebaseFunctions, ceremonyInputData, ceremonyPrefix, circuits)
        } catch (error: any) {
            const errorBody = JSON.parse(JSON.stringify(error))
            showError(
                `[${errorBody.code}] ${error.message} ${!errorBody.details ? "" : `\n${errorBody.details}`}`,
                true
            )
        }

        await sleep(5000) // Cloud function unexpected termination workaround.

        spinner.succeed(
            `Congratulations, the setup of ceremony ${theme.text.bold(
                ceremonyInputData.title
            )} has been successfully completed ${
                theme.emojis.tada
            }. You will be able to find all the files and info respectively in the ceremony bucket and database document.`
        )
    }
    terminate(handle)
}

export default setup
